import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import {
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from './queue.constants';
import { QueueModule } from './queue.module';

describe('QueueModule', () => {
  it('should compile with the shared BullMQ connection', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  }, 15000);

  it('should declare the video-processing retry policy', () => {
    expect(VIDEO_PROCESSING_QUEUE).toBe('video-processing');
    expect(PROCESS_VIDEO_JOB_OPTIONS).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
  });
});
