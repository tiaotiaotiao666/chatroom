import * as net from 'net';
import * as os from 'os';

const clientMap: Map<net.Socket, string> = new Map();

// 用于存储已使用的昵称，防止重复
const usedNicknames: Set<string> = new Set();

function getLocalIP(): string {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]!) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

const server = net.createServer((socket) => {
    const clientInfo = `${socket.remoteAddress}:${socket.remotePort}`;//socket.remoteAddress - 客户端的 IP 地址   socket.remotePort - 客户端的端口号 
    console.log(`新客户端加入: ${clientInfo}`);
    
    socket.write('=== 欢迎进入聊天室 ===\n');
    socket.write('请输入你的昵称：\n');
    
    let nickname = '';
    let isSettingNickname = true;
    let hasLeftChat = false; // 添加标志，防止重复广播离开消息
    
    socket.on('data', (data) => {
        const msg = data.toString().trim();
        
        // 处理心跳请求（不广播，直接响应）
        if (msg === 'PING') {
            socket.write('PONG\n');
            return;
        }
        
        if (isSettingNickname) {
            // 检查昵称是否已被使用
            if (usedNicknames.has(msg)) {
                socket.write(`[系统] 昵称 "${msg}" 已被使用，请选择其他昵称：\n`);
                return;
            }
            
            nickname = msg || `用户${Date.now()}`;
            clientMap.set(socket, nickname);
            usedNicknames.add(nickname); // 记录已使用的昵称
            isSettingNickname = false;
            
            const welcomeMsg = `\n欢迎 ${nickname} 加入聊天室！\n`;
            console.log(welcomeMsg);
            
            clientMap.forEach((name, client) => {
                if (client !== socket && client.writable) {
                    client.write(`[系统] ${nickname} 加入了聊天室\n`);
                }
            });
            
            socket.write(`你的昵称是: ${nickname}\n`);
            socket.write('现在可以开始聊天了！\n');
            socket.write('\n[系统] 可用命令:\n');
            socket.write('  /quit 或 /exit - 退出聊天室\n');
            socket.write('  /users - 查看在线用户\n');
            socket.write('  /help - 显示帮助信息\n');
            socket.write('  @用户名 消息 - 私聊指定用户\n');
            socket.write('> ');
            return;
        }
        
        if (!msg) return;
        
        if (msg === '/quit' || msg === '/exit') {
            hasLeftChat = true; // 标记已主动离开
            const leaveName = clientMap.get(socket) || nickname;
            
            // 广播离开消息给其他用户
            clientMap.forEach((name, client) => {
                if (client !== socket && client.writable) {
                    client.write(`[系统] ${leaveName} 离开了聊天室\n`);
                }
            });
            
            console.log(`${leaveName} 退出了聊天室`);
            clientMap.delete(socket); // 从 Map 中移除
            usedNicknames.delete(leaveName); // 释放昵称
            
            socket.write('[系统] 再见！\n');
            socket.end();
            return;
        }
        
        if (msg === '/users') {
            const users = Array.from(clientMap.values());
            socket.write(`[系统] 在线用户 (${users.length}人): ${users.join(', ')}\n`);
            return;
        }
        
        if (msg === '/help') {
            socket.write('[系统] 可用命令:\n');
            socket.write('  /quit 或 /exit - 退出聊天室\n');
            socket.write('  /users - 查看在线用户\n');
            socket.write('  /help - 显示帮助信息\n');
            socket.write('  @用户名 消息 - 私聊指定用户\n');
            return;
        }
        
        // 处理私聊消息（格式：@用户名 消息内容）
        if (msg.startsWith('@')) {
            const spaceIndex = msg.indexOf(' ');
            if (spaceIndex > 1) {
                const targetNickname = msg.substring(1, spaceIndex);
                const privateMsg = msg.substring(spaceIndex + 1);
                
                // 检查是否私聊自己
                if (targetNickname === nickname) {
                    socket.write('[系统] 不能私聊自己\n');
                    return;
                }
                
                // 查找目标用户
                let targetSocket: net.Socket | undefined;
                clientMap.forEach((name, client) => {
                    if (name === targetNickname) {
                        targetSocket = client;
                    }
                });
                
                if (targetSocket && targetSocket.writable) {
                    // 发送给目标用户
                    (targetSocket as net.Socket).write(`[私聊-${nickname}] ${privateMsg}\n`);
                    // 确认发送成功给发送者
                    socket.write(`[系统] 已发送私聊给 ${targetNickname}\n`);
                } else {
                    socket.write(`[系统] 用户 "${targetNickname}" 不在线\n`);
                }
                return;
            } else {
                socket.write('[系统] 私聊格式错误，请使用：@用户名 消息内容\n');
                return;
            }
        }
        
        console.log(`[${nickname}] ${msg}`);
        
        const broadcastMsg = `[${nickname}] ${msg}\n`;
        clientMap.forEach((name, client) => {
            if (client !== socket && client.writable) {
                client.write(broadcastMsg);
            }
        });
    });

    socket.on('close', () => {
        // 如果已经主动离开（通过 /quit），就不需要再处理
        if (hasLeftChat) {
            return;
        }
        
        const name = clientMap.get(socket);
        const displayName = name || nickname || clientInfo;
        
        if (name) {
            console.log(`客户端已断开: ${name}`);
            usedNicknames.delete(name); // 释放昵称，允许其他人使用
            clientMap.delete(socket);
            
            // 向其他在线用户广播离开消息
            clientMap.forEach((_, client) => {
                if (client.writable) {
                    client.write(`[系统] ${displayName} 离开了聊天室\n`);
                }
            });
        } else {
            // 如果没有昵称，说明可能是在设置昵称前就断开了
            console.log(`客户端已断开: ${clientInfo}`);
        }
    });
    
    socket.on('error', (err) => {
        console.error(`Socket错误: ${err.message}`);
        
        // 在删除前先获取昵称，用于后续广播
        const errorNickname = clientMap.get(socket);
        
        // 如果已经有昵称，需要从 Map 和集合中移除
        if (errorNickname) {
            usedNicknames.delete(errorNickname);
            clientMap.delete(socket);
            
            // 向其他在线用户广播离开消息
            clientMap.forEach((_, client) => {
                if (client.writable) {
                    client.write(`[系统] ${errorNickname} 离开了聊天室\n`);
                }
            });
            
            console.log(`客户端已断开: ${errorNickname}`);
            hasLeftChat = true; // 阻止 close 事件重复处理
        } else {
            // 如果没有昵称，说明可能是在设置昵称前就断开了
            clientMap.delete(socket);
            console.log(`客户端已断开: ${clientInfo}`);
        }
    });
});

const PORT = 3500;
const localIP = getLocalIP();

server.listen(PORT, '0.0.0.0', () => {
    console.log('========================================');
    console.log('   聊天室服务器已启动');
    console.log('========================================');
    console.log(`本地访问: localhost:${PORT}`);
    console.log(`局域网访问: ${localIP}:${PORT}`);
    console.log('========================================');
    console.log('其他电脑可以通过以下地址连接:');
    console.log(`${localIP}:${PORT}`);
    console.log('========================================');
});

server.on('error', (err) => {
    console.error(`服务器错误: ${err.message}`);
});

process.on('SIGINT', () => {
    console.log('\n服务器正在关闭...');
    server.close(() => {
        console.log('服务器已关闭');
        process.exit(0);
    });
});


