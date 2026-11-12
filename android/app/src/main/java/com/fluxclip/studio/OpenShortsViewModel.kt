package com.fluxclip.studio.viewmodel

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fluxclip.studio.ui.ClipItemUiModel
import com.fluxclip.studio.ui.FluxClipTab
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlin.math.abs

enum class VideoInputMode { YOUTUBE_URL, DIRECT_URL, LOCAL_UPLOAD }

data class UnifiedMediaSourceDto(
    val sourceMode: VideoInputMode,
    val originalUri: String,
    val resolvedStreamUri: String,
    val containerFormat: String,
    val durationMs: Long,
    val supportsByteRange: Boolean
)

data class MasterAudioPayloadDto(
    val fileName: String,
    val format: String, // "mp3" | "wav"
    val sizeBytes: Long,
    val durationMs: Long,
    val uri: Uri? = null
)

data class OpenShortsProcessRequest(
    val url: String? = null,
    val videoUploadId: String? = null,
    val audioUploadId: String? = null,
    val transcriptText: String,
    val acknowledged: Boolean = true
)

data class OpenShortsProcessResponse(
    val job_id: String,
    val status: String,
    val unifiedSource: UnifiedMediaSourceDto? = null
)

data class WordLevelCaptionDto(
    val word: String,
    val startMs: Long,
    val endMs: Long
)

data class OpenShortsRemoteClipDto(
    val index: Int,
    val clipId: String,
    val title: String,
    val engagementReasoning: String = "",
    val start: Double,
    val end: Double,
    val startMs: Long,
    val endMs: Long,
    val wordCaptions: List<WordLevelCaptionDto> = emptyList(),
    val video_url: String,
    val download_url: String? = null
)

data class OpenShortsResultDto(
    val clips: List<OpenShortsRemoteClipDto> = emptyList()
)

data class OpenShortsStatusResponse(
    val job_id: String,
    val status: String, // "queued" | "validating" | "analyzing" | "extracting" | "transcribing" | "rendering" | "completed" | "failed"
    val stageMessage: String? = null,
    val logs: List<String> = emptyList(),
    val result: OpenShortsResultDto? = null,
    val error: String? = null
)

interface OpenShortsBackendClient {
    suspend fun initChunkedUpload(fileName: String, mimeType: String, totalSizeBytes: Long, kind: String): String
    suspend fun uploadRawChunk(uploadId: String, chunkIndex: Int, byteOffset: Long, bytes: ByteArray)
    suspend fun completeUpload(uploadId: String)
    suspend fun submitJob(request: OpenShortsProcessRequest): OpenShortsProcessResponse
    suspend fun pollJobStatus(jobId: String): OpenShortsStatusResponse
}

data class FluxClipUiState(
    val activeTab: FluxClipTab = FluxClipTab.UPLOADS,
    val urlInput: String = "",
    val selectedFileUri: Uri? = null,
    val selectedFileName: String? = null,
    val selectedFileSize: Long = 0L,
    val videoDurationMs: Long = 0L,
    val transcriptText: String = "",
    val transcriptFileName: String? = null,
    val masterAudio: MasterAudioPayloadDto? = null,
    val validationError: String? = null,
    val isGenerating: Boolean = false,
    val pipelineStage: String? = null,
    val clips: List<ClipItemUiModel> = emptyList(),
    val selectedClipIndex: Int = 1,
    val isPlaying: Boolean = false
)

private const val AV_SYNC_TOLERANCE_MS = 2500L

class OpenShortsViewModel(
    private val backendClient: OpenShortsBackendClient
) : ViewModel() {

    private val _uiState = MutableStateFlow(FluxClipUiState())
    val uiState: StateFlow<FluxClipUiState> = _uiState.asStateFlow()

    fun onUrlInputChanged(newUrl: String) {
        _uiState.update { it.copy(urlInput = newUrl, validationError = null) }
    }

    fun onLocalFilePicked(uri: Uri?, fileName: String? = null, sizeBytes: Long = 0L, durationMs: Long = 0L) {
        _uiState.update {
            it.copy(
                selectedFileUri = uri,
                selectedFileName = fileName,
                selectedFileSize = sizeBytes,
                videoDurationMs = durationMs,
                validationError = null
            )
        }
    }

    fun onTranscriptSupplied(transcriptContent: String, fileName: String? = null) {
        _uiState.update {
            it.copy(
                transcriptText = transcriptContent,
                transcriptFileName = fileName,
                validationError = null
            )
        }
    }

    fun onMasterAudioSupplied(audio: MasterAudioPayloadDto?) {
        _uiState.update { it.copy(masterAudio = audio, validationError = null) }
    }

    fun onSelectTab(tab: FluxClipTab) {
        _uiState.update { it.copy(activeTab = tab) }
    }

    fun onSelectClip(clip: ClipItemUiModel) {
        _uiState.update { it.copy(selectedClipIndex = clip.index, isPlaying = false) }
    }

    fun onTogglePlay() {
        _uiState.update { it.copy(isPlaying = !it.isPlaying) }
    }

    fun dispatchGenerateClips() {
        val currentState = _uiState.value
        if (currentState.isGenerating) return

        if (currentState.urlInput.isBlank() && currentState.selectedFileUri == null) {
            _uiState.update { it.copy(validationError = "Provide a valid YouTube/Direct URL or local video file.") }
            return
        }

        val masterAudio = currentState.masterAudio
        if (masterAudio == null || currentState.transcriptText.isBlank()) {
            _uiState.update { it.copy(validationError = "Manual timecoded transcript (.srt/.txt) and master audio (.mp3/.wav) are required.") }
            return
        }

        if (currentState.videoDurationMs > 0L && masterAudio.durationMs > 0L) {
            if (abs(masterAudio.durationMs - currentState.videoDurationMs) > AV_SYNC_TOLERANCE_MS) {
                _uiState.update { it.copy(validationError = "Audio/video duration mismatch exceeds 2.5s sync tolerance.") }
                return
            }
        }

        viewModelScope.launch(Dispatchers.IO) {
            _uiState.update {
                it.copy(isGenerating = true, pipelineStage = "Uploading payloads...", validationError = null)
            }

            try {
                // Initialize raw binary uploads for master audio (and local video if selected)
                val audioUploadId = backendClient.initChunkedUpload(
                    fileName = masterAudio.fileName,
                    mimeType = if (masterAudio.format == "wav") "audio/wav" else "audio/mpeg",
                    totalSizeBytes = masterAudio.sizeBytes,
                    kind = "audio"
                )

                // Finalize and submit
                val processRes = backendClient.submitJob(
                    OpenShortsProcessRequest(
                        url = currentState.urlInput.trim().takeIf { it.isNotEmpty() },
                        videoUploadId = null,
                        audioUploadId = audioUploadId,
                        transcriptText = currentState.transcriptText,
                        acknowledged = true
                    )
                )

                while (true) {
                    delay(1000L)
                    val statusRes = backendClient.pollJobStatus(processRes.job_id)

                    _uiState.update {
                        it.copy(pipelineStage = statusRes.stageMessage ?: "Processing...")
                    }

                    if (statusRes.status == "completed" && statusRes.result != null) {
                        val mappedClips = statusRes.result.clips.mapIndexed { idx, dto ->
                            val duration = ((dto.endMs - dto.startMs) / 1000L).toInt().coerceAtLeast(1)
                            val spokenPreview = dto.wordCaptions.joinToString(" ") { it.word }.trim()
                            ClipItemUiModel(
                                index = idx + 1,
                                label = "Clip ${idx + 1}",
                                durationSeconds = duration,
                                currentSeconds = 0,
                                caption = spokenPreview,
                                videoUrl = dto.video_url,
                                downloadUrl = dto.download_url ?: dto.video_url
                            )
                        }

                        _uiState.update {
                            it.copy(
                                clips = mappedClips,
                                selectedClipIndex = 1,
                                isGenerating = false,
                                pipelineStage = null,
                                activeTab = FluxClipTab.CLIPS
                            )
                        }
                        break
                    } else if (statusRes.status == "failed" || statusRes.status == "cancelled") {
                        _uiState.update {
                            it.copy(
                                isGenerating = false,
                                pipelineStage = null,
                                validationError = statusRes.error ?: statusRes.stageMessage ?: "Pipeline processing failed."
                            )
                        }
                        break
                    }
                }
            } catch (ex: Exception) {
                _uiState.update {
                    it.copy(
                        isGenerating = false,
                        pipelineStage = null,
                        validationError = ex.message ?: "Network error connecting to processing server."
                    )
                }
            }
        }
    }
}
