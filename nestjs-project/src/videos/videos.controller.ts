import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { PartUrlsResponseDto } from './dto/part-urls-response.dto';
import { RequestPartUrlsDto } from './dto/request-part-urls.dto';
import { SignedUrlResponseDto } from './dto/signed-url-response.dto';
import { UploadedPartsResponseDto } from './dto/uploaded-parts-response.dto';
import { VideoResponseDto, toVideoResponse } from './dto/video-response.dto';
import { VideosService } from './videos.service';

const errorEnvelope = { $ref: getSchemaPath(ApiErrorEnvelope) };

const PUBLIC_ID_PARAM = {
  name: 'publicId',
  description: 'Public video identifier (11 chars, base64url)',
  example: 'Xk3_9aQ-0bZ',
};

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft in the caller channel and opens a multipart upload in object storage. File bytes are never sent to the API: request presigned part URLs next and PUT each part directly to storage.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload opened',
    type: InitiateUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 413,
    description: 'VIDEO_TOO_LARGE — declared size exceeds 10 GiB',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 415,
    description:
      'UNSUPPORTED_VIDEO_FORMAT — content type or file extension outside the MP4/WebM allowlist',
    schema: errorEnvelope,
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    const { video, partCount } = await this.videosService.initiateUpload(
      user.sub,
      dto,
    );
    return {
      ...toVideoResponse(video),
      upload: { partSize: video.part_size, partCount },
    };
  }

  @Post(':publicId/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiOperation({
    summary: 'Request presigned part upload URLs',
    description:
      'Issues short-lived presigned UploadPart URLs for the requested part numbers. PUT each part directly to its URL and keep the returned ETag header for the complete call. Also used to resume an interrupted upload.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned URLs, ascending by part number',
    type: PartUrlsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'VALIDATION_ERROR, or INVALID_PART_NUMBER when a part number exceeds the upload part count',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_AWAITING_UPLOAD',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 410,
    description: 'UPLOAD_EXPIRED — the multipart upload no longer exists',
    schema: errorEnvelope,
  })
  requestPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: RequestPartUrlsDto,
  ): Promise<PartUrlsResponseDto> {
    return this.videosService.requestPartUrls(
      publicId,
      user.sub,
      dto.partNumbers,
    );
  }

  @Get(':publicId/upload/parts')
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiOperation({
    summary: 'List uploaded parts',
    description:
      'Lists the parts already stored for the in-progress upload, so an interrupted client can resume by uploading only the missing parts.',
  })
  @ApiResponse({
    status: 200,
    description: 'Stored parts, ascending by part number',
    type: UploadedPartsResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_AWAITING_UPLOAD',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 410,
    description: 'UPLOAD_EXPIRED — the multipart upload no longer exists',
    schema: errorEnvelope,
  })
  async listUploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<UploadedPartsResponseDto> {
    const parts = await this.videosService.listUploadedParts(
      publicId,
      user.sub,
    );
    return { parts };
  }

  @Post(':publicId/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiOperation({
    summary: 'Complete the upload',
    description:
      'Assembles the uploaded parts, verifies the stored size against the declared size, moves the video to processing and enqueues the processing job.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload assembled; video is now processing',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'VALIDATION_ERROR, or INVALID_UPLOAD_PARTS when parts do not cover 1..partCount or do not match the stored parts',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_AWAITING_UPLOAD',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 410,
    description: 'UPLOAD_EXPIRED — the multipart upload no longer exists',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 422,
    description:
      'UPLOAD_SIZE_MISMATCH — stored size differs from the declared size',
    schema: errorEnvelope,
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<VideoResponseDto> {
    const video = await this.videosService.completeUpload(
      publicId,
      user.sub,
      dto.parts,
    );
    return toVideoResponse(video);
  }

  @Delete(':publicId/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiOperation({
    summary: 'Abort the upload',
    description:
      'Aborts the in-progress multipart upload and marks the video as failed (upload_aborted).',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_AWAITING_UPLOAD',
    schema: errorEnvelope,
  })
  abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<void> {
    return this.videosService.abortUpload(publicId, user.sub);
  }

  @Get(':publicId')
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiOperation({
    summary: 'Get a video',
    description:
      "Returns the owner's view of the video, including processing status and the extracted metadata once ready. Poll it to follow processing.",
  })
  @ApiResponse({ status: 200, description: 'Video', type: VideoResponseDto })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorEnvelope,
  })
  async getVideo(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<VideoResponseDto> {
    return toVideoResponse(
      await this.videosService.findOwnedOrFail(publicId, user.sub),
    );
  }

  @Get(':publicId/stream')
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiOperation({
    summary: 'Get a streaming URL',
    description:
      'Returns a short-lived presigned URL for playback. Storage answers Range requests with 206 Partial Content, so playback starts without a full download.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned stream URL',
    type: SignedUrlResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_READY',
    schema: errorEnvelope,
  })
  getStreamUrl(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<SignedUrlResponseDto> {
    return this.videosService.getMediaUrl(publicId, user.sub, 'stream');
  }

  @Get(':publicId/download')
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiOperation({
    summary: 'Get a download URL',
    description:
      'Returns a short-lived presigned URL that downloads the original file as an attachment.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned download URL',
    type: SignedUrlResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_READY',
    schema: errorEnvelope,
  })
  getDownloadUrl(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<SignedUrlResponseDto> {
    return this.videosService.getMediaUrl(publicId, user.sub, 'download');
  }

  @Get(':publicId/thumbnail')
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiOperation({
    summary: 'Get a thumbnail URL',
    description:
      'Returns a short-lived presigned URL for the generated JPEG thumbnail.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned thumbnail URL',
    type: SignedUrlResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_READY',
    schema: errorEnvelope,
  })
  getThumbnailUrl(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<SignedUrlResponseDto> {
    return this.videosService.getMediaUrl(publicId, user.sub, 'thumbnail');
  }
}
