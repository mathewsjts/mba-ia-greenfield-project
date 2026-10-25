import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import queueConfig from '../config/queue.config';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        prefix: config.prefix,
        connection: {
          host: config.host,
          port: config.port,
          // Required by BullMQ workers; blocking commands must not time out.
          maxRetriesPerRequest: null,
        },
      }),
    }),
  ],
})
export class QueueModule {}
