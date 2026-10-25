import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  type ValueTransformer,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

export enum VideoStatus {
  Draft = 'draft',
}

export enum VideoProcessingStatus {
  AwaitingUpload = 'awaiting_upload',
  Processing = 'processing',
  Ready = 'ready',
  Failed = 'failed',
}

export type VideoFailureReason =
  | 'unsupported_format'
  | 'processing_error'
  | 'size_mismatch'
  | 'upload_expired'
  | 'upload_aborted';

// pg returns bigint as string; sizes up to 10 GiB fit safely in a JS number.
const bigintToNumber: ValueTransformer = {
  to: (value: number) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

@Entity('videos')
@Check(
  'CHK_videos_size_bytes',
  '"size_bytes" > 0 AND "size_bytes" <= 10737418240',
)
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 11, unique: true })
  public_id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 100 })
  title: string;

  @Column({ type: 'enum', enum: VideoStatus, default: VideoStatus.Draft })
  status: VideoStatus;

  @Column({
    type: 'enum',
    enum: VideoProcessingStatus,
    default: VideoProcessingStatus.AwaitingUpload,
  })
  processing_status: VideoProcessingStatus;

  @Column({ type: 'varchar', length: 32, nullable: true })
  failure_reason: VideoFailureReason | null;

  @Column({ type: 'varchar', length: 255 })
  original_file_name: string;

  @Column({ type: 'varchar', length: 32 })
  content_type: string;

  @Column({ type: 'bigint', transformer: bigintToNumber })
  size_bytes: number;

  @Column({ type: 'text', nullable: true })
  upload_id: string | null;

  @Column({ type: 'integer' })
  part_size: number;

  @Column({ type: 'double precision', nullable: true })
  duration: number | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  container: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  video_codec: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  audio_codec: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
