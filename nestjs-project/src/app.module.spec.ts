import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { VideoProcessor } from './video-processing/video.processor';
import { VideosService } from './videos/videos.service';

describe('AppModule', () => {
  it('should produce video jobs but never register the VideoProcessor', async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(module.get(VideosService, { strict: false })).toBeInstanceOf(
      VideosService,
    );
    expect(() => module.get(VideoProcessor, { strict: false })).toThrow();

    await module.close();
  }, 30000);
});
