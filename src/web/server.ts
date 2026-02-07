import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { logger } from '../utils/logger.js';
import { DailyTracker } from '../state/dailyTracker.js';
import { Conversation, CouponType, IITM_MESSES } from '../conversation/types.js';
import { getHistory, getTodayDeals, getStats, COUPONS_DIRECTORY, DealRecord } from '../state/history.js';
import { getAuthState, logout, isClientReady, setEventCallbacks } from '../whatsapp/client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface WebServerCallbacks {
  onStartSession: () => { startedSession: CouponType | null };
  onStopSession: () => { stoppedSession: CouponType | null; nextSession: CouponType | null };
  onSetPreference: (type: CouponType, messNames: string[] | null) => void;
  onConfirmPurchase: () => void;
  onDeclinePurchase: () => void;
  onConfirmPayment: () => void;
  onToggleSessionStatus: (type: CouponType) => { newStatus: 'bought' | 'needed' };
  onLogout: () => Promise<void>;
  onRestart: () => Promise<void>;
  onManualComplete: (conversationId: string) => Promise<{ success: boolean; error?: string }>;
  onManualFail: (conversationId: string, reason?: string) => Promise<{ success: boolean; error?: string }>;
  getStatus: () => {
    mode: string;
    dailyStatus: string;
    lunchPreference: string[] | null;
    dinnerPreference: string[] | null;
    currentSession: CouponType | null;
    lunchPaused: boolean;
    dinnerPaused: boolean;
    lunchBought: boolean;
    dinnerBought: boolean;
  };
  getActiveConversations: () => Conversation[];
  getPendingConfirmation: () => { convId: string | null; conversation: Conversation | null };
  getPendingPayment: () => { convId: string | null; conversation: Conversation | null };
  getConversationMessages: (conversationId: string) => Array<{ id: string; sender: string; text: string; timestamp: Date; hasMedia?: boolean }>;
}

export class WebServer {
  private app: express.Application;
  private server: ReturnType<typeof createServer>;
  private io: SocketServer;
  private callbacks: WebServerCallbacks;
  private port: number;

  constructor(port: number, callbacks: WebServerCallbacks) {
    this.port = port;
    this.callbacks = callbacks;
    this.app = express();
    this.server = createServer(this.app);
    this.io = new SocketServer(this.server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST']
      }
    });

    this.setupRoutes();
    this.setupSocketHandlers();
  }

  private setupRoutes(): void {
    // Serve static files
    this.app.use(express.static(join(__dirname, 'public')));
    this.app.use(express.json());

    // API Routes
    this.app.get('/api/status', (_req: Request, res: Response) => {
      const status = this.callbacks.getStatus();
      const conversations = this.callbacks.getActiveConversations();
      const pendingConfirm = this.callbacks.getPendingConfirmation();
      const pendingPayment = this.callbacks.getPendingPayment();

      res.json({
        ...status,
        activeConversations: conversations,
        pendingConfirmation: pendingConfirm.conversation,
        pendingPayment: pendingPayment.conversation,
        messes: IITM_MESSES
      });
    });

    this.app.post('/api/start', (_req: Request, res: Response) => {
      const result = this.callbacks.onStartSession();
      this.broadcastStatus();
      res.json(result);
    });

    this.app.post('/api/stop', (_req: Request, res: Response) => {
      const result = this.callbacks.onStopSession();
      this.broadcastStatus();
      res.json(result);
    });

    this.app.post('/api/preference', (req: Request, res: Response) => {
      const { type, messNames } = req.body;
      if (!type || (type !== 'lunch' && type !== 'dinner')) {
        res.status(400).json({ error: 'Invalid type' });
        return;
      }
      // Handle array of mess names (null or empty array means "any")
      const preferences = messNames && messNames.length > 0 ? messNames : null;
      this.callbacks.onSetPreference(type, preferences);
      this.broadcastStatus();
      res.json({ success: true });
    });

    this.app.post('/api/confirm', (_req: Request, res: Response) => {
      this.callbacks.onConfirmPurchase();
      this.broadcastStatus();
      res.json({ success: true });
    });

    this.app.post('/api/decline', (_req: Request, res: Response) => {
      this.callbacks.onDeclinePurchase();
      this.broadcastStatus();
      res.json({ success: true });
    });

    this.app.post('/api/paid', (_req: Request, res: Response) => {
      this.callbacks.onConfirmPayment();
      this.broadcastStatus();
      res.json({ success: true });
    });

    this.app.post('/api/toggle/:type', (req: Request, res: Response) => {
      const type = req.params.type as CouponType;
      if (type !== 'lunch' && type !== 'dinner') {
        res.status(400).json({ error: 'Invalid type. Must be lunch or dinner.' });
        return;
      }
      const result = this.callbacks.onToggleSessionStatus(type);
      this.broadcastStatus();
      res.json({ success: true, type, newStatus: result.newStatus });
    });

    // History API endpoints
    this.app.get('/api/history', (req: Request, res: Response) => {
      const days = parseInt(req.query.days as string) || 30;
      const history = getHistory(days);
      res.json({ deals: history });
    });

    this.app.get('/api/history/today', (_req: Request, res: Response) => {
      const deals = getTodayDeals();
      res.json({ deals });
    });

    this.app.get('/api/history/stats', (req: Request, res: Response) => {
      const days = parseInt(req.query.days as string) || 30;
      const stats = getStats(days);
      res.json(stats);
    });

    // Get conversation messages (chat history)
    this.app.get('/api/conversation/:id/messages', (req: Request, res: Response) => {
      const conversationId = req.params.id as string;
      const messages = this.callbacks.getConversationMessages(conversationId);
      res.json({ messages });
    });

    // Manually mark conversation as completed (successful deal)
    this.app.post('/api/conversation/:id/complete', async (req: Request, res: Response) => {
      const conversationId = req.params.id as string;
      logger.info('Manual complete requested', { conversationId });

      try {
        const result = await this.callbacks.onManualComplete(conversationId);
        this.broadcastStatus();

        if (result.success) {
          this.broadcastNotification('success', 'Deal Completed', 'Conversation marked as successful');
        }

        res.json(result);
      } catch (error) {
        logger.error('Manual complete failed', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    // Manually mark conversation as failed
    this.app.post('/api/conversation/:id/fail', async (req: Request, res: Response) => {
      const conversationId = req.params.id as string;
      const reason = req.body?.reason || 'Manually cancelled';
      logger.info('Manual fail requested', { conversationId, reason });

      try {
        const result = await this.callbacks.onManualFail(conversationId, reason);
        this.broadcastStatus();

        if (result.success) {
          this.broadcastNotification('info', 'Deal Cancelled', 'Conversation marked as failed');
        }

        res.json(result);
      } catch (error) {
        logger.error('Manual fail failed', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
      }
    });

    // Serve coupon images
    this.app.use('/coupons', express.static(COUPONS_DIRECTORY));

    // Auth endpoints
    this.app.get('/api/auth/status', (_req: Request, res: Response) => {
      const authState = getAuthState();
      res.json({
        isLoggedIn: authState.isReady,
        isAuthenticated: authState.isAuthenticated,
        userPhone: authState.userPhone ? this.maskPhone(authState.userPhone) : null,
        hasQR: !!authState.currentQR
      });
    });

    this.app.get('/api/auth/qr', (_req: Request, res: Response) => {
      const authState = getAuthState();
      if (authState.isReady) {
        res.json({ qr: null, message: 'Already logged in' });
      } else if (authState.currentQR) {
        res.json({ qr: authState.currentQR });
      } else {
        res.json({ qr: null, message: 'Waiting for QR code...' });
      }
    });

    this.app.post('/api/auth/logout', async (_req: Request, res: Response) => {
      try {
        logger.info('Logout requested via web dashboard');
        await this.callbacks.onLogout();
        res.json({ success: true, message: 'Logged out successfully' });
      } catch (error) {
        logger.error('Logout failed', error);
        res.status(500).json({ success: false, error: 'Logout failed' });
      }
    });

    // Serve index.html for root
    this.app.get('/', (_req: Request, res: Response) => {
      res.sendFile(join(__dirname, 'public', 'index.html'));
    });
  }

  // Mask phone number for privacy (show only last 4 digits)
  private maskPhone(phone: string): string {
    if (phone.length <= 4) return phone;
    return '••••••' + phone.slice(-4);
  }

  private setupSocketHandlers(): void {
    this.io.on('connection', (socket) => {
      logger.info('Web client connected', { socketId: socket.id });

      // Send initial auth status
      const authState = getAuthState();
      socket.emit('auth', {
        isLoggedIn: authState.isReady,
        userPhone: authState.userPhone ? this.maskPhone(authState.userPhone) : null,
        hasQR: !!authState.currentQR
      });

      // Send QR if available and not logged in
      if (!authState.isReady && authState.currentQR) {
        socket.emit('qr', { qr: authState.currentQR });
      }

      // Send status only if logged in
      if (authState.isReady) {
        socket.emit('status', this.getFullStatus());
      }

      socket.on('disconnect', () => {
        logger.debug('Web client disconnected', { socketId: socket.id });
      });
    });
  }

  // Setup WhatsApp event callbacks to broadcast to web clients
  setupWhatsAppCallbacks(): void {
    setEventCallbacks({
      onQR: (qr) => {
        logger.info('Broadcasting QR code to web clients');
        this.io.emit('qr', { qr });
        this.io.emit('auth', { isLoggedIn: false, hasQR: true });
      },
      onAuthenticated: () => {
        logger.info('Broadcasting authenticated status');
        this.io.emit('auth', { isLoggedIn: false, isAuthenticated: true, message: 'Authenticated, loading...' });
      },
      onReady: (userPhone) => {
        logger.info('Broadcasting ready status');
        this.io.emit('auth', {
          isLoggedIn: true,
          userPhone: this.maskPhone(userPhone),
          hasQR: false
        });
        this.io.emit('qr', { qr: null });
        this.broadcastStatus();
        this.broadcastNotification('success', 'Logged In', `Connected as ••••••${userPhone.slice(-4)}`);
      },
      onDisconnected: (reason) => {
        logger.info('Broadcasting disconnected status', { reason });
        this.io.emit('auth', { isLoggedIn: false, hasQR: false, message: 'Disconnected' });
        this.broadcastNotification('warning', 'Disconnected', reason);
      },
      onAuthFailure: (msg) => {
        logger.info('Broadcasting auth failure');
        this.io.emit('auth', { isLoggedIn: false, hasQR: false, error: msg });
        this.broadcastNotification('error', 'Auth Failed', msg);
      }
    });
  }

  private getFullStatus() {
    const status = this.callbacks.getStatus();
    const conversations = this.callbacks.getActiveConversations();
    const pendingConfirm = this.callbacks.getPendingConfirmation();
    const pendingPayment = this.callbacks.getPendingPayment();

    return {
      ...status,
      activeConversations: conversations,
      pendingConfirmation: pendingConfirm.conversation,
      pendingPayment: pendingPayment.conversation,
      messes: IITM_MESSES,
      timestamp: new Date().toISOString()
    };
  }

  // Call this to broadcast status updates to all connected clients
  broadcastStatus(): void {
    const status = this.getFullStatus();
    logger.debug('Broadcasting status', {
      hasPendingConfirmation: !!status.pendingConfirmation,
      hasPendingPayment: !!status.pendingPayment,
      activeConversations: status.activeConversations?.length || 0
    });
    this.io.emit('status', status);
  }

  // Call this to send a log message to all clients
  broadcastLog(level: string, message: string, data?: any): void {
    this.io.emit('log', {
      level,
      message,
      data,
      timestamp: new Date().toISOString()
    });
  }

  // Call this when a notification should be shown
  broadcastNotification(type: 'info' | 'success' | 'warning' | 'error', title: string, message: string): void {
    this.io.emit('notification', { type, title, message });
  }

  start(): void {
    try {
      this.server.listen(this.port, () => {
        logger.info(`Web server running at http://localhost:${this.port}`);
        console.log(`\n${'='.repeat(50)}`);
        console.log(`  WEB DASHBOARD: http://localhost:${this.port}`);
        console.log(`${'='.repeat(50)}\n`);
      });

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          logger.warn(`Port ${this.port} is in use, trying ${this.port + 1}`);
          this.port += 1;
          this.server.listen(this.port);
        } else {
          logger.error('Web server error', err);
        }
      });
    } catch (error) {
      logger.error('Failed to start web server', error);
    }
  }

  getIO(): SocketServer {
    return this.io;
  }
}
