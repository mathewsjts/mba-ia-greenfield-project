import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { RootConfigModule } from './config/root-config.module';
import { QueueModule } from './queue/queue.module';
import { VideosModule } from './videos/videos.module';

@Module({
  imports: [RootConfigModule, AuthModule, QueueModule, VideosModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
