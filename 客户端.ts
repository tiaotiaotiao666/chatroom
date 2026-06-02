import * as net from 'net';
import * as readline from 'readline';

// ==================== 配置参数 ====================
const HOST = process.argv[2] || 'localhost';
const PORT = parseInt(process.argv[3] || '3500');
const RECONNECT_INTERVAL = 3000; // 重连间隔（毫秒）
const HEARTBEAT_INTERVAL = 30000; // 心跳间隔（30秒）
const HEARTBEAT_TIMEOUT = 60000; // 心跳超时时间（60秒）
const MAX_RECONNECT_ATTEMPTS = 10; // 最大重连次数（设置为0表示无限重连，但TypeScript中建议使用大数如999）

// ==================== 全局变量 ====================
let client: net.Socket | null = null;
let reconnectAttempts = 0;
let heartbeatTimer: NodeJS.Timeout | null = null;
let heartbeatTimeoutTimer: NodeJS.Timeout | null = null;
let isConnecting = false;
let shouldReconnect = true; // 是否应该自动重连

// ==================== TCP 消息缓冲处理 ====================
// TCP 是流式协议，需要处理消息边界
let buffer = ''; // 接收缓冲区

/**
 * 处理 TCP 数据流
 * TCP 不保证消息边界，可能分包或粘包
 * 我们使用 \n 作为消息分隔符
 */
function processData(data: Buffer | string): void {
    buffer += data.toString();
    
    // 按换行符分割消息
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        // 提取完整消息
        const message = buffer.substring(0, newlineIndex);
        buffer = buffer.substring(newlineIndex + 1);
        
        if (message.trim()) {
            handleMessage(message);
        }
    }
}

/**
 * 处理单条消息
 */
function handleMessage(message: string): void {
    // 清除当前输入行
    process.stdout.write('\r' + ' '.repeat(80) + '\r');
    
    // 显示消息
    process.stdout.write(message + '\n');
    
    // 检测心跳响应
    if (message === 'PONG') {
        resetHeartbeatTimeout();
        return;
    }
    
    // 重新显示提示符
    if (rl) {
        rl.prompt(true);
    }
}

// ==================== 心跳机制 ====================

/**
 * 启动心跳定时器
 */
function startHeartbeat(): void {
    stopHeartbeat();
    
    // 每30秒发送一次心跳
    heartbeatTimer = setInterval(() => {
        if (client && !client.destroyed) {
            client.write('PING\n');
            
            // 设置超时检测
            heartbeatTimeoutTimer = setTimeout(() => {
                console.log('\n[系统] 心跳超时，服务器可能已断开');
                handleDisconnect();
            }, HEARTBEAT_TIMEOUT);
        }
    }, HEARTBEAT_INTERVAL);
}

/**
 * 停止心跳
 */
function stopHeartbeat(): void {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    if (heartbeatTimeoutTimer) {
        clearTimeout(heartbeatTimeoutTimer);
        heartbeatTimeoutTimer = null;
    }
}

/**
 * 重置心跳超时计时器（收到 PONG 时调用）
 */
function resetHeartbeatTimeout(): void {
    if (heartbeatTimeoutTimer) {
        clearTimeout(heartbeatTimeoutTimer);
        heartbeatTimeoutTimer = null;
    }
}

// ==================== 连接管理 ====================

/**
 * 创建新连接
 */
function createConnection(): void {
    if (isConnecting) {
        return;
    }
    
    isConnecting = true;
    
    if (reconnectAttempts > 0) {
        console.log(`\n正在尝试重连... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS || '∞'})`);
    }
    
    client = net.createConnection({ host: HOST, port: PORT }, () => {
        isConnecting = false;
        reconnectAttempts = 0; // 重置重连计数
        
        console.log('✅ 已连接到服务器！\n');
        
        // 启动心跳
        startHeartbeat();
        
        // 显示欢迎信息
        if (rl) {
            rl.prompt(true);
        }
    });
    
    // 设置编码
    client.setEncoding('utf8');
    
    // 禁用 Nagle 算法，减少延迟
    client.setNoDelay(true);
    
    // 保持连接活跃（操作系统级别的心跳）
    client.setKeepAlive(true, 60000);
    
    // 监听数据事件
    client.on('data', (data) => {
        processData(data);
    });
    
    // 监听错误事件
    client.on('error', (err) => {
        console.error(`\n❌ 连接错误: ${err.message}`);
        isConnecting = false;
        handleDisconnect();
    });
    
    // 监听关闭事件
    client.on('close', () => {
        console.log('\n⚠️  与服务器断开连接');
        isConnecting = false;
        handleDisconnect();
    });
    
    // 监听结束事件
    client.on('end', () => {
        console.log('\n⚠️  服务器主动关闭连接');
        isConnecting = false;
        handleDisconnect();
    });
}

/**
 * 处理断线逻辑
 */
function handleDisconnect(): void {
    stopHeartbeat();
    
    // 清空缓冲区
    buffer = '';
    
    // 检查是否应该重连
    if (!shouldReconnect) {
        console.log('[系统] 已退出，不再重连');
        process.exit(0);
        return;
    }
    
    // 检查重连次数限制
    if (MAX_RECONNECT_ATTEMPTS >= 999) {
        // 无限重连模式，不限制次数
    } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log(`[系统] 已达到最大重连次数 (${MAX_RECONNECT_ATTEMPTS})，停止重连`);
        process.exit(1);
        return;
    }
    
    // 指数退避重连策略
    reconnectAttempts++;
    const delay = Math.min(RECONNECT_INTERVAL * Math.pow(2, reconnectAttempts - 1), 30000);
    
    console.log(`[系统] ${delay/1000}秒后尝试第 ${reconnectAttempts} 次重连...`);
    
    setTimeout(() => {
        createConnection();
    }, delay);
}

/**
 * 安全发送消息
 */
function sendMessage(message: string): void {
    if (client && !client.destroyed) {
        // 确保消息以 \n 结尾（TCP 消息边界）
        client.write(message + '\n');
    } else {
        console.log('\n[系统] 未连接到服务器，消息发送失败');
    }
}

// ==================== readline 交互 ====================

let rl: readline.Interface | null = null;

function setupReadline(): void {
    rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '> '
    });
    
    // 处理用户输入
    rl.on('line', (line) => {
        const input = line.trim();
        
        if (!input) {
            rl!.prompt();
            return;
        }
        
        // 特殊命令：强制退出（不重连）
        if (input === '/forcequit' || input === '/fq') {
            shouldReconnect = false;
            sendMessage('/quit');
            setTimeout(() => {
                if (client) {
                    client.end();
                }
                console.log('再见！');
                process.exit(0);
            }, 500);
            return;
        }
        
        // 发送消息
        sendMessage(input);
    });
    
    // 处理 Ctrl+D
    rl.on('close', () => {
        console.log('\n正在退出...');
        shouldReconnect = false;
        sendMessage('/quit');
        setTimeout(() => {
            if (client) {
                client.end();
            }
            console.log('再见！');
            process.exit(0);
        }, 500);
    });
}

// ==================== 信号处理 ====================

// 处理 Ctrl+C (SIGINT)
process.on('SIGINT', () => {
    console.log('\n\n[系统] 收到退出信号 (Ctrl+C)');
    shouldReconnect = false;
    sendMessage('/quit');
    setTimeout(() => {
        if (client) {
            client.end();
        }
        console.log('再见！');
        process.exit(0);
    }, 500);
});

// 处理进程终止
process.on('exit', () => {
    stopHeartbeat();
    if (client && !client.destroyed) {
        client.end();
    }
});

// 处理未捕获的异常
process.on('uncaughtException', (err) => {
    console.error('\n❌ 未捕获的异常:', err);
    process.exit(1);
});

// ==================== 启动程序 ====================

console.log('========================================');
console.log('   高级聊天室客户端');
console.log('========================================');
console.log(`服务器地址: ${HOST}:${PORT}`);
console.log(`心跳间隔: ${HEARTBEAT_INTERVAL/1000}秒`);
console.log(`自动重连: ${MAX_RECONNECT_ATTEMPTS >= 999 ? '启用(无限)' : `启用(${MAX_RECONNECT_ATTEMPTS}次)`}`);
console.log('========================================');
console.log('提示:');
console.log('  - 使用 /forcequit 或 /fq 强制退出（不重连）');
console.log('  - 使用 Ctrl+C 优雅退出');
console.log('  - 断线后会自动重连');
console.log('========================================\n');

// 设置 readline
setupReadline();

// 创建初始连接
createConnection();
