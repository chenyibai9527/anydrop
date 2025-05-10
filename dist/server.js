"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const app = (0, express_1.default)();
const httpServer = (0, http_1.createServer)(app);
// 配置Socket.IO以正确处理二进制数据
const io = new socket_io_1.Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e8, // 增加缓冲区大小到约100MB
});
app.use((0, cors_1.default)());
app.use(express_1.default.static(path_1.default.join(__dirname, '../public')));
// 存储连接的设备信息
const devices = new Map();
// 清理过期设备
function cleanupDevices() {
    const now = Date.now();
    for (const [id, device] of devices.entries()) {
        if (now - device.lastSeen > 30000) { // 30秒未活动则清理
            devices.delete(id);
            io.emit('device-left', { id });
        }
    }
}
// 定期清理过期设备
setInterval(cleanupDevices, 10000);
io.on('connection', (socket) => {
    console.log('设备已连接:', socket.id);
    // 如果设备已存在，先移除旧连接
    if (devices.has(socket.id)) {
        devices.delete(socket.id);
    }
    // 发送设备信息
    socket.emit('device-info', {
        id: socket.id,
        devices: Array.from(devices.values())
    });
    // 广播新设备加入
    socket.broadcast.emit('device-joined', {
        id: socket.id
    });
    // 存储设备信息
    devices.set(socket.id, {
        id: socket.id,
        lastSeen: Date.now()
    });
    // 更新设备最后活动时间
    socket.on('heartbeat', () => {
        const device = devices.get(socket.id);
        if (device) {
            device.lastSeen = Date.now();
        }
    });
    // 处理设备信息
    socket.on('device-info', (data) => {
        const deviceInfo = devices.get(socket.id);
        if (deviceInfo) {
            deviceInfo.type = data.type;
            deviceInfo.icon = data.icon;
            deviceInfo.name = data.name;
            // 广播设备信息变更
            io.emit('device-info-update', {
                id: socket.id,
                type: data.type,
                icon: data.icon,
                name: data.name
            });
        }
    });
    // 处理消息发送
    socket.on('send-message', (data) => {
        const { targetId, message } = data;
        io.to(targetId).emit('message', {
            fromId: socket.id,
            message
        });
    });
    // 处理文件传输请求
    socket.on('file-transfer-request', (data) => {
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
    socket.on('file-transfer-response', (data) => {
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
    socket.on('file-data', (data) => {
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
        }
        catch (error) {
            console.error('处理文件数据时出错:', error);
        }
    });
    // 处理取消传输
    socket.on('cancel-transfer', (data) => {
        const { targetId, transferId } = data;
        console.log(`取消文件传输: ${socket.id} -> ${targetId}, ID: ${transferId}`);
        // 转发取消请求给目标设备
        io.to(targetId).emit('cancel-transfer', {
            fromId: socket.id,
            transferId
        });
    });
    // 处理断开连接
    socket.on('disconnect', () => {
        console.log('设备已断开:', socket.id);
        devices.delete(socket.id);
        io.emit('device-left', {
            id: socket.id
        });
    });
});
const PORT = process.env.PORT || 3000;
// 获取本机IP地址
function getLocalIP() {
    const interfaces = os_1.default.networkInterfaces();
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
