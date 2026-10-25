import { Test } from '@nestjs/testing';
import { VideoProcessor } from './video-processing/video.processor';
import { VideosController } from './videos/videos.controller';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile with the VideoProcessor and without HTTP controllers', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideoProcessor, { strict: false })).toBeInstanceOf(
      VideoProcessor,
    );
    expect(() => module.get(VideosController, { strict: false })).toThrow();

    await module.close();
  }, 30000);
});
