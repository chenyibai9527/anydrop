import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import os from 'os';

interface DeviceInfo {
  id: string;
  lastSeen: number;
  type?: string;
  icon?: string;
  name?: string;
  groupKey?: string;
}

const app = express();
const httpServer = createServer(app);
// 配置Socket.IO以正确处理二进制数据
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 1e8, // 增加缓冲区大小到约100MB
});

app.use(cors());
app.use(express.static(path.join(__dirname, '../public')));

// 存储连接的设备信息
const devices = new Map<string, DeviceInfo>();

// 新增：基于公网IP分组
const ipGroups = new Map<string, Set<string>>();

// 清理过期设备
function cleanupDevices() {
  const now = Date.now();
  for (const [id, device] of devices.entries()) {
    if (now - device.lastSeen > 30000) { // 30秒未活动则清理
      // 从ipGroups中移除
      if (device.groupKey) {
        ipGroups.get(device.groupKey)?.delete(id);
        if (ipGroups.get(device.groupKey)?.size === 0) {
          ipGroups.delete(device.groupKey);
        }
        // 通知同组设备
        ipGroups.get(device.groupKey)?.forEach(groupId => {
          io.to(groupId).emit('device-left', { id });
        });
      }
      devices.delete(id);
    }
  }
}

// 定期清理过期设备
setInterval(cleanupDevices, 10000);

// 判断是否为内网IP
function isPrivateIP(ip: string) {
  return /^10\./.test(ip) ||
         /^192\.168\./.test(ip) ||
         /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip);
}

// 获取设备所属的网络组
function getNetworkGroup(ip: string) {
  if (isPrivateIP(ip)) {
    // 对于内网IP，提取网段作为组标识
    const parts = ip.split('.');
    if (parts[0] === '10') {
      return 'LAN-10';
    } else if (parts[0] === '192' && parts[1] === '168') {
      return 'LAN-192.168';
    } else if (parts[0] === '172') {
      return 'LAN-172';
    }
  }
  // 对于公网IP，使用IP的前三段作为组标识
  const parts = ip.split('.');
  return parts.slice(0, 3).join('.');
}

io.on('connection', (socket) => {
  console.log('设备已连接:', socket.id);

  // 如果设备已存在，先移除旧连接
  if (devices.has(socket.id)) {
    devices.delete(socket.id);
  }

  // 获取公网IP（兼容代理）
  const ip = socket.handshake.headers['x-forwarded-for']?.toString().split(',')[0].trim() || socket.handshake.address;
  console.log('新连接IP:', ip, 'SocketID:', socket.id);

  // 使用新的分组逻辑
  const groupKey = getNetworkGroup(ip);
  if (!ipGroups.has(groupKey)) ipGroups.set(groupKey, new Set());
  ipGroups.get(groupKey)!.add(socket.id);

  // 只发送同组下的设备信息
  socket.emit('device-info', {
    id: socket.id,
    devices: Array.from(ipGroups.get(groupKey)!).filter(id => id !== socket.id).map(id => devices.get(id)).filter(Boolean)
  });

  // 广播新设备加入（只广播给同组下的其他设备）
  ipGroups.get(groupKey)!.forEach(id => {
    if (id !== socket.id) {
      io.to(id).emit('device-joined', { id: socket.id });
    }
  });

  // 存储设备信息
  devices.set(socket.id, {
    id: socket.id,
    lastSeen: Date.now(),
    groupKey: groupKey
  });

  // 更新设备最后活动时间
  socket.on('heartbeat', () => {
    const device = devices.get(socket.id);
    if (device) {
      device.lastSeen = Date.now();
    }
  });

  // 修改所有 io.emit 为只对同组广播
  // 设备信息变更
  socket.on('device-info', (data: { type: string; icon: string; name: string }) => {
    const deviceInfo = devices.get(socket.id);
    if (deviceInfo) {
      deviceInfo.type = data.type;
      deviceInfo.icon = data.icon;
      deviceInfo.name = data.name;
      // 保持groupKey不变
      deviceInfo.groupKey = deviceInfo.groupKey;
      // 只通知同组
      if (deviceInfo.groupKey) {
        ipGroups.get(deviceInfo.groupKey)!.forEach(id => {
          io.to(id).emit('device-info-update', {
            id: socket.id,
            type: data.type,
            icon: data.icon,
            name: data.name
          });
        });
      }
    }
  });

  // 处理消息发送
  socket.on('send-message', (data: { targetId: string; message: string }) => {
    const { targetId, message } = data;
    io.to(targetId).emit('message', {
      fromId: socket.id,
      message
    });
  });

  // 处理文件传输请求
  socket.on('file-transfer-request', (data: { targetId: string; fileName: string; fileSize: number; transferId: string }) => {
    const { targetId, fileName, fileSize, transferId } = data;
    console.log(`文件传输请求: ${socket.id} -> ${targetId}, 文件: ${fileName}, 大小: ${fileSize}字节, ID: ${transferId}`);
    
    io.to(targetId).emit('file-transfer-request', {
      fromId: socket.id,
      fileName,
      fileSize,
      transferId
    });
  });

  // 处理文件传输响应
  socket.on('file-transfer-response', (data: { targetId: string; transferId: string; accepted: boolean }) => {
    const { targetId, transferId, accepted } = data;
    console.log(`文件传输响应: ${socket.id} -> ${targetId}, ID: ${transferId}, 接受: ${accepted}`);
    
    // 将接收方的响应转发给发送方
    io.to(targetId).emit('file-transfer-response', {
      fromId: socket.id,
      transferId,
      accepted
    });
  });

  // 处理文件数据
  socket.on('file-data', (data: { targetId: string; chunk: ArrayBuffer; fileName: string; transferId: string; offset: number; totalSize: number }) => {
    try {
      const { targetId, chunk, fileName, transferId, offset, totalSize } = data;
      
      console.log(`文件数据传输: ${socket.id} -> ${targetId}, 文件: ${fileName}, 偏移: ${offset}, ID: ${transferId}, 数据大小: ${chunk && chunk.byteLength ? chunk.byteLength : '未知'}`);
      
      // 直接转发数据，不做修改
      io.to(targetId).emit('file-data', {
        fromId: socket.id,
        chunk,
        fileName,
        transferId,
        offset,
        totalSize
      });
    } catch (error) {
      console.error('处理文件数据时出错:', error);
    }
  });

  // 处理取消传输
  socket.on('cancel-transfer', (data: { targetId: string; transferId: string }) => {
    const { targetId, transferId } = data;
    console.log(`取消文件传输: ${socket.id} -> ${targetId}, ID: ${transferId}`);
    
    // 转发取消请求给目标设备
    io.to(targetId).emit('cancel-transfer', {
      fromId: socket.id,
      transferId
    });
  });

  // WebRTC 信令消息转发
  socket.on('signal', (data: { targetId: string; signal: any }) => {
    io.to(data.targetId).emit('signal', {
      fromId: socket.id,
      signal: data.signal
    });
  });

  // P2P失败事件转发
  socket.on('p2p-failed', (data: { targetId: string; transferId: string }) => {
    io.to(data.targetId).emit('p2p-failed', {
      fromId: socket.id,
      transferId: data.transferId
    });
  });

  // 处理断开连接
  socket.on('disconnect', () => {
    console.log('设备已断开:', socket.id);
    const device = devices.get(socket.id);
    if (device) {
      const groupKey = device.groupKey;
      if (groupKey) {
        ipGroups.get(groupKey)?.delete(socket.id);
        if (ipGroups.get(groupKey)?.size === 0) ipGroups.delete(groupKey);
        // 通知同组设备
        ipGroups.get(groupKey)?.forEach(id => {
          io.to(id).emit('device-left', { id: socket.id });
        });
      }
    }
    devices.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3030;

// 获取本机IP地址
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

httpServer.listen(Number(PORT), '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log(`服务器运行在:`);
  console.log(`- 本地访问: http://localhost:${PORT}`);
  console.log(`- 局域网访问: http://${localIP}:${PORT}`);
}); 