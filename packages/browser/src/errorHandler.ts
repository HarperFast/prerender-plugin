import logger from './util/Logger.js';

export type ErrorHandlerOptions = {
	/** Called on SIGTERM/SIGINT to drain work before exit (e.g. the worker's shutdown). */
	onTerminate?: () => Promise<void> | void;
	/** Hard cap on the graceful drain before forcing exit(0). Default 12s. */
	shutdownDeadlineMs?: number;
};

export class ErrorHandler {
	private onTerminate?: () => Promise<void> | void;
	private shutdownDeadlineMs: number;
	private terminating = false;

	constructor(options: ErrorHandlerOptions = {}) {
		this.onTerminate = options.onTerminate;
		this.shutdownDeadlineMs = options.shutdownDeadlineMs ?? 12000;
		this.setupGlobalHandlers();
	}

	private setupGlobalHandlers() {
		process.on('uncaughtException', this.handleUncaughtException.bind(this));
		process.on('unhandledRejection', this.handleUnhandledRejection.bind(this));
		process.on('SIGTERM', this.handleTermination.bind(this));
		process.on('SIGINT', this.handleTermination.bind(this));
	}

	private handleUncaughtException(error: Error) {
		logger.fatal(
			{
				err: error,
				stack: error.stack,
				type: 'uncaughtException',
			},
			'Uncaught Exception occurred'
		);

		this.gracefulShutdown(1);
	}

	private handleUnhandledRejection(reason: any, promise: Promise<any>) {
		logger.fatal(
			{
				err: reason,
				stack: reason?.stack,
				type: 'unhandledRejection',
				promise: promise.toString(),
			},
			'Unhandled Promise Rejection occurred'
		);

		this.gracefulShutdown(1);
	}

	private async handleTermination(signal: string) {
		if (this.terminating) return; // ignore a second SIGTERM/SIGINT while already draining
		this.terminating = true;
		logger.info({ signal }, 'Termination signal received');

		// Hard backstop: if the drain hangs, still exit before the supervisor SIGKILLs us.
		const backstop = setTimeout(() => process.exit(0), this.shutdownDeadlineMs);
		backstop.unref();
		try {
			await this.onTerminate?.();
		} catch (err) {
			logger.error({ err }, 'error during graceful shutdown');
		}
		clearTimeout(backstop);
		process.exit(0);
	}

	private gracefulShutdown(exitCode: number) {
		setTimeout(() => {
			process.exit(exitCode);
		}, 1000);
	}
}
