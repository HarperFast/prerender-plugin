import logger from './util/Logger.js';

export class ErrorHandler {
	constructor() {
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

	private handleTermination(signal: string) {
		logger.info({ signal }, 'Termination signal received');
		this.gracefulShutdown(0);
	}

	private gracefulShutdown(exitCode: number) {
		setTimeout(() => {
			process.exit(exitCode);
		}, 1000);
	}
}
