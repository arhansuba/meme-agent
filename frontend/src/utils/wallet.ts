import { Connection, VersionedTransaction, PublicKey, Transaction } from '@solana/web3.js';
import logger from './logger';
import { parsePrivateKey } from './keys';

// Types
interface WalletBalance {
  balance: number;
  address: string;
}

interface TransactionResult {
  signature: string;
  status: 'success' | 'error';
  message: string;
}

interface RPCConfig {
  url: string;
  name: 'quicknode' | 'helius' | 'fallback';
}

interface ConnectionConfig {
  primary: RPCConfig | null;
  fallback: RPCConfig | null;
}



export class AgentWallet {
  private primaryConnection: Connection | null = null;
  private fallbackConnection: Connection | null = null;
  private isUsingFallback: boolean = false;
  private readonly baseUrl: string;
  private readonly maxRetries: number = 3;
  private readonly retryDelay: number = 2000;

  constructor() {
    // Initialize RPC configurations
    const config = this.initializeConfig();
    
    // Set up connections
    if (config.primary) {
      this.primaryConnection = this.createConnection(config.primary.url);
    }

    if (config.fallback) {
      this.fallbackConnection = this.createConnection(config.fallback.url);
      if (!config.primary) {
        this.primaryConnection = this.fallbackConnection;
      }
    }

    this.baseUrl = process.env.BOT_API_BASE_URL || 
                   process.env.NEXT_PUBLIC_API_BASE_URL || 
                   'http://localhost:3000';

    // Validate configuration
    if (!this.primaryConnection && !this.fallbackConnection) {
      throw new Error('No RPC connections available');
    }
  }

  private initializeConfig(): ConnectionConfig {
    let quickNodeUrl = process.env.NEXT_PUBLIC_QUICKNODE_RPC_URL;
    const heliusApiKey = process.env.NEXT_PUBLIC_HELIUS_API_KEY;

    const config: ConnectionConfig = {
      primary: null,
      fallback: null
    };

    if (quickNodeUrl) {
      // Ensure QuickNode URL has proper protocol
      quickNodeUrl = this.validateAndFormatUrl(quickNodeUrl);
      config.primary = {
        url: quickNodeUrl,
        name: 'quicknode'
      };
    }

    if (heliusApiKey) {
      const heliusUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
      config[quickNodeUrl ? 'fallback' : 'primary'] = {
        url: heliusUrl,
        name: 'helius'
      };
    }

    // Use public fallback if no other options
    if (!config.primary && !config.fallback) {
      config.primary = {
        url: process.env.NEXT_PUBLIC_FALLBACK_RPC_URL || 'https://api.mainnet-beta.solana.com',
        name: 'fallback'
      };
    }

    return config;
  }

  private validateAndFormatUrl(url: string): string {
    // Remove any trailing slashes
    url = url.trim().replace(/\/+$/, '');
    
    // Add protocol if missing
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `https://${url}`;
    }
    
    // Validate URL format
    try {
      new URL(url);
    } catch (error) {
      throw new Error(`Invalid RPC URL format: ${url}`);
    }
    
    return url;
  }

  private createConnection(url: string): Connection {
    const validatedUrl = this.validateAndFormatUrl(url);
    
    return new Connection(validatedUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
      wsEndpoint: undefined, // Disable WebSocket
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        return fetch(input, {
          ...init,
          headers: {
            ...init?.headers,
            'Content-Type': 'application/json'
          }
        });
      }
    });
  }

  // Rest of the class implementation remains the same...
  public async getActiveConnection(): Promise<Connection> {
    if (!this.isUsingFallback) {
      try {
        if (!this.primaryConnection) {
          throw new Error('Primary connection not initialized');
        }
        await this.primaryConnection.getSlot();
        return this.primaryConnection;
      } catch (error) {
        logger.warn('Primary RPC failed, switching to fallback:', error);
        this.isUsingFallback = true;
      }
    }

    if (!this.fallbackConnection) {
      throw new Error('Fallback connection not initialized');
    }

    try {
      await this.fallbackConnection.getSlot();
      return this.fallbackConnection;
    } catch (error) {
      logger.error('All RPC connections failed:', error);
      throw new Error('No available RPC connection');
    }
  }

  public async getBalance(): Promise<WalletBalance> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/api/wallet`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        
        if (!this.isValidBalanceResponse(data)) {
          throw new Error('Invalid balance response format');
        }

        return data;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error');
        logger.warn(`Balance fetch attempt ${attempt} failed:`, error);
        
        if (attempt < this.maxRetries) {
          await new Promise(resolve => setTimeout(resolve, this.retryDelay));
        }
      }
    }

    throw lastError || new Error('Failed to get wallet balance');
  }


  public async sendSOL(recipient: string, amount: number): Promise<TransactionResult> {
    try {
      // Validate inputs
      if (!this.isValidPublicKey(recipient)) {
        throw new Error('Invalid recipient address');
      }

      if (!this.isValidAmount(amount)) {
        throw new Error('Invalid amount');
      }

      const response = await fetch(`${this.baseUrl}/api/wallet/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          recipient, 
          amount,
          rpcUrl: this.isUsingFallback ? 'helius' : 'quicknode' 
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Transaction failed');
      }

      return await response.json();
    } catch (error) {
      logger.error('Error sending SOL:', error);
      throw error;
    }
  }

  public async signAndSendTransaction(transaction: VersionedTransaction): Promise<string> {
    try {
      const serializedTransaction = Buffer.from(transaction.serialize()).toString('base64');
      
      const response = await fetch(`${this.baseUrl}/api/wallet/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          transaction: serializedTransaction,
          rpcUrl: this.isUsingFallback ? 'helius' : 'quicknode' 
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Transaction signing failed');
      }

      const result = await response.json();
      return result.signature;
    } catch (error) {
      logger.error('Transaction signing error:', error);
      throw error;
    }
  }

  public async getAddress(): Promise<string> {
    const walletInfo = await this.getBalance();
    return walletInfo.address;
  }

  public async initialize(): Promise<boolean> { 
    try {
      const connection = await this.getActiveConnection();
      const slot = await connection.getSlot();
      logger.success('Wallet initialized successfully. Current slot:', slot);
      return true;
    } catch (error) {
      if (error instanceof Error) {
        logger.error('Wallet initialization error:', error.message);
      } else {
        logger.error('Wallet initialization error:', error);
      }
      return false;
    }
  }

  public async processWalletText(text: string): Promise<any> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tokenizer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text })
      });

      if (!response.ok) {
        throw new Error('Failed to process text');
      }

      const data = await response.json();
      return data.embedding;
    } catch (error) {
      logger.error('Error processing wallet text:', error);
      throw error;
    }
  }


  // Validation helpers
  private isValidPublicKey(address: string): boolean {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  private isValidAmount(amount: number): boolean {
    return amount > 0 && Number.isFinite(amount);
  }

  private isValidBalanceResponse(data: any): data is WalletBalance {
    return (
      data &&
      typeof data.balance === 'number' &&
      typeof data.address === 'string' &&
      this.isValidPublicKey(data.address)
    );
  }
}

// Export singleton instance
export const agentWallet = new AgentWallet();

// TransactionValidator class
export interface TransactionValidationConfig {
  maxFee: number;
  minConfirmations: number;
  timeout: number;
}

export class TransactionValidator {
  private static readonly DEFAULT_CONFIG: TransactionValidationConfig = {
    maxFee: 0.1, // SOL
    minConfirmations: 1,
    timeout: 60000 // ms
  };

  static async validateTransaction(
    transaction: Transaction | VersionedTransaction,
    connection: Connection,
    config: Partial<TransactionValidationConfig> = {}
  ): Promise<{ isValid: boolean; reason?: string }> {
    const finalConfig = { ...this.DEFAULT_CONFIG, ...config };

    try {
      // Check fee
      const fee = await connection.getFeeForMessage(
        'version' in transaction ? transaction.message : transaction.compileMessage(),
        'confirmed'
      );

      if (!fee.value) {
        return { isValid: false, reason: 'Unable to estimate fee' };
      }

      if (fee.value / 1e9 > finalConfig.maxFee) {
        return { isValid: false, reason: 'Transaction fee too high' };
      }

      // Additional validation logic here
      return { isValid: true };
    } catch (error) {
      logger.error('Transaction validation error:', error);
      return { isValid: false, reason: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  static async monitorTransaction(
    signature: string,
    connection: Connection,
    config: Partial<TransactionValidationConfig> = {}
  ): Promise<boolean> {
    const finalConfig = { ...this.DEFAULT_CONFIG, ...config };
    const startTime = Date.now();

    while (Date.now() - startTime < finalConfig.timeout) {
      try {
        const status = await connection.getSignatureStatus(signature);
        
        if (status.value?.confirmationStatus === 'finalized' || 
            (status.value?.confirmations ?? 0) >= finalConfig.minConfirmations) {
          return true;
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        logger.error('Transaction monitoring error:', error);
      }
    }

    return false;
  }
}

// ConnectionMonitor class
export class ConnectionMonitor {
  private static readonly LATENCY_THRESHOLD = 1000; // ms
  private static readonly ERROR_THRESHOLD = 3;

  private errorCount = 0;
  private lastLatency = 0;

  constructor(private connection: Connection) {}

  async checkHealth(): Promise<{
    isHealthy: boolean;
    latency: number;
    errorCount: number;
  }> {
    try {
      const start = performance.now();
      await this.connection.getSlot();
      this.lastLatency = performance.now() - start;
      
      const isHealthy = this.lastLatency < ConnectionMonitor.LATENCY_THRESHOLD;
      
      if (!isHealthy) {
        this.errorCount++;
      } else {
        this.errorCount = Math.max(0, this.errorCount - 1);
      }

      return {
        isHealthy,
        latency: this.lastLatency,
        errorCount: this.errorCount
      };
    } catch (error) {
      this.errorCount++;
      logger.error('Connection health check error:', error);
      
      return {
        isHealthy: false,
        latency: this.lastLatency,
        errorCount: this.errorCount
      };
    }
  }

  shouldSwitchEndpoint(): boolean {
    return this.errorCount >= ConnectionMonitor.ERROR_THRESHOLD;
  }

  reset(): void {
    this.errorCount = 0;
    this.lastLatency = 0;
  }
}
