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
		if (this.terminating) {
			// A second signal (e.g. an impatient Ctrl+C) forces an immediate, unclean exit
			// instead of waiting out the drain.
			logger.warn({ signal }, 'Second termination signal — forcing exit');
			process.exit(1);
		}
		this.terminating = true;
		logger.info({ signal }, 'Termination signal received');

		// Hard backstop: if the drain hangs, exit before the supervisor SIGKILLs us — with a
		// NON-zero code so the orchestrator sees an unclean/timed-out shutdown, not a clean one.
		const backstop = setTimeout(() => process.exit(1), this.shutdownDeadlineMs);
		backstop.unref();
		let exitCode = 0;
		try {
			await this.onTerminate?.();
		} catch (err) {
			// The drain failed/was incomplete — signal an unclean shutdown to the orchestrator.
			logger.error({ err }, 'error during graceful shutdown');
			exitCode = 1;
		}
		clearTimeout(backstop);
		process.exit(exitCode);
	}

	private gracefulShutdown(exitCode: number) {
		setTimeout(() => {
			process.exit(exitCode);
		}, 1000);
	}
}
