import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { VIDEO_PROCESSING_QUEUE } from './queue/queue.constants';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const logger = new Logger('VideoWorker');

  // app.close() runs the shutdown hooks, where @nestjs/bullmq closes the worker
  // after the in-flight job finishes, so no job is left stalled. Handled here
  // instead of enableShutdownHooks(), which re-raises the signal and exits non-zero.
  const shutdown = async (signal: NodeJS.Signals) => {
    logger.log(`${signal} received, closing the worker`);
    await app.close();
    logger.log('Worker closed');
    process.exit(0);
  };
  process.once('SIGTERM', (signal) => void shutdown(signal));
  process.once('SIGINT', (signal) => void shutdown(signal));

  logger.log(
    `Video worker started, consuming queue "${VIDEO_PROCESSING_QUEUE}"`,
  );
}
void bootstrap();
