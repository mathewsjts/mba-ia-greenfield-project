import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1792878763609 implements MigrationInterface {
  name = 'CreateVideos1792878763609';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."videos_status_enum" AS ENUM('draft')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."videos_processing_status_enum" AS ENUM('awaiting_upload', 'processing', 'ready', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "public_id" character varying(11) NOT NULL, "channel_id" uuid NOT NULL, "title" character varying(100) NOT NULL, "status" "public"."videos_status_enum" NOT NULL DEFAULT 'draft', "processing_status" "public"."videos_processing_status_enum" NOT NULL DEFAULT 'awaiting_upload', "failure_reason" character varying(32), "original_file_name" character varying(255) NOT NULL, "content_type" character varying(32) NOT NULL, "size_bytes" bigint NOT NULL, "upload_id" text, "part_size" integer NOT NULL, "duration" double precision, "width" integer, "height" integer, "container" character varying(32), "video_codec" character varying(32), "audio_codec" character varying(32), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_39a1f0fe7991162aace659078ec" UNIQUE ("public_id"), CONSTRAINT "CHK_videos_size_bytes" CHECK ("size_bytes" > 0 AND "size_bytes" <= 10737418240), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_023a8e4f3f1a34ff3d8ca04a4c" ON "videos" ("channel_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_023a8e4f3f1a34ff3d8ca04a4c"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(
      `DROP TYPE "public"."videos_processing_status_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."videos_status_enum"`);
  }
}
