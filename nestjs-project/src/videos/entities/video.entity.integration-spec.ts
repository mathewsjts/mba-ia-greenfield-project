import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generatePublicId } from '../public-id';
import { Video, VideoProcessingStatus, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'video_owner@example.com', password: 'hashed' });
    channel = await dataSource.getRepository(Channel).save({
      name: 'owner',
      nickname: 'video_owner',
      user_id: user.id,
    });
  });

  function draft(overrides: Partial<Video> = {}): Partial<Video> {
    return {
      public_id: generatePublicId(),
      channel_id: channel.id,
      title: 'aula',
      original_file_name: 'aula.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      part_size: 67108864,
      ...overrides,
    };
  }

  it('should default to draft / awaiting_upload with empty metadata', async () => {
    const saved = await videoRepository.save(draft());
    const loaded = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(loaded.status).toBe(VideoStatus.Draft);
    expect(loaded.processing_status).toBe(VideoProcessingStatus.AwaitingUpload);
    expect(loaded.failure_reason).toBeNull();
    expect(loaded.upload_id).toBeNull();
    expect(loaded.duration).toBeNull();
    expect(loaded.width).toBeNull();
    expect(loaded.height).toBeNull();
    expect(loaded.container).toBeNull();
    expect(loaded.video_codec).toBeNull();
    expect(loaded.audio_codec).toBeNull();
  });

  it('should reject a duplicate public_id with a unique violation', async () => {
    const publicId = generatePublicId();
    await videoRepository.save(draft({ public_id: publicId }));

    await expect(
      videoRepository.save(draft({ public_id: publicId })),
    ).rejects.toMatchObject({
      constructor: QueryFailedError,
      driverError: expect.objectContaining({ code: '23505' }),
    });
  });

  it('should read a 10 GiB size_bytes back as a number', async () => {
    const saved = await videoRepository.save(
      draft({ size_bytes: 10737418240 }),
    );
    const loaded = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(loaded.size_bytes).toBe(10737418240);
  });

  it('should reject sizes outside (0, 10 GiB]', async () => {
    await expect(
      videoRepository.save(draft({ size_bytes: 10737418241 })),
    ).rejects.toBeInstanceOf(QueryFailedError);
    await expect(
      videoRepository.save(draft({ size_bytes: 0 })),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('should delete videos in cascade when their channel is removed', async () => {
    await videoRepository.save(draft());
    await videoRepository.save(draft());

    await dataSource.getRepository(Channel).delete({ id: channel.id });

    expect(await videoRepository.count()).toBe(0);
  });
});
