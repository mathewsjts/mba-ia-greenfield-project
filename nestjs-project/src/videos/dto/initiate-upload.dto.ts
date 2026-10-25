import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
} from 'class-validator';

export class InitiateUploadDto {
  /** Original file name; its extension must match `contentType` (.mp4/.m4v or .webm). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName: string;

  /** Declared file size in bytes (at most 10737418240). */
  @IsInt()
  @Min(1)
  size: number;

  /** MIME type of the file: `video/mp4` or `video/webm`. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  contentType: string;

  /** Video title; defaults to the file name without its extension. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 100)
  title?: string;
}
