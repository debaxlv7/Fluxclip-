package com.fluxclip.studio.ui

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.CloudUpload
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import com.fluxclip.studio.viewmodel.MasterAudioPayloadDto
import com.fluxclip.studio.viewmodel.OpenShortsViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

enum class FluxClipTab { UPLOADS, CLIPS }

data class ClipItemUiModel(
    val index: Int,
    val label: String,
    val durationSeconds: Int,
    val currentSeconds: Int,
    val caption: String,
    val videoUrl: String? = null,
    val downloadUrl: String? = null,
    val thumbnailUrl: String? = null
)

suspend fun saveClipToGalleryMediaStore(context: Context, clip: ClipItemUiModel): Result<Uri> =
    withContext(Dispatchers.IO) {
        runCatching {
            val rawUrl = (clip.downloadUrl?.takeIf { it.isNotBlank() } ?: clip.videoUrl)
                ?: throw IllegalStateException("Clip video URL is missing.")
            val fileName = "fluxclip_${clip.label.lowercase().replace(Regex("[^a-z0-9_-]"), "_")}_9x16.mp4"
            val resolver = context.contentResolver
            val contentValues = ContentValues().apply {
                put(MediaStore.Video.Media.DISPLAY_NAME, fileName)
                put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
                put(MediaStore.Video.Media.DATE_ADDED, System.currentTimeMillis() / 1000)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    put(MediaStore.Video.Media.RELATIVE_PATH, "${Environment.DIRECTORY_MOVIES}/FluxClip")
                    put(MediaStore.Video.Media.IS_PENDING, 1)
                }
            }
            val collection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            } else {
                MediaStore.Video.Media.EXTERNAL_CONTENT_URI
            }
            val itemUri = resolver.insert(collection, contentValues)
                ?: throw IllegalStateException("Failed to create MediaStore Gallery entry.")

            try {
                val connection = (URL(rawUrl).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15_000
                    readTimeout = 60_000
                    requestMethod = "GET"
                    connect()
                }
                if (connection.responseCode !in 200..299) {
                    throw IllegalStateException("Download failed with HTTP ${connection.responseCode}")
                }
                connection.inputStream.use { input ->
                    resolver.openOutputStream(itemUri)?.use { output ->
                        input.copyTo(output, bufferSize = 64 * 1024)
                    } ?: throw IllegalStateException("Unable to open Gallery output stream.")
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val publishValues = ContentValues().apply {
                        put(MediaStore.Video.Media.IS_PENDING, 0)
                    }
                    resolver.update(itemUri, publishValues, null, null)
                }
                itemUri
            } catch (e: Throwable) {
                resolver.delete(itemUri, null, null)
                throw e
            }
        }
    }

private val SoftCoralBgTop = Color(0xFFFDF6F3)
private val SoftCoralBgBottom = Color(0xFFF7E6DF)
private val SoftCoralPrimaryStart = Color(0xFFE67763)
private val SoftCoralPrimaryEnd = Color(0xFFC63D2F)
private val DeepWarmInk = Color(0xFF2B1E1C)
private val MutedWarmTaupe = Color(0xFF8C726C)
private val SurfaceCardTint = Color(0xFFFBF2EE)
private val OutlineWarm = Color(0xFFECD7CF)

@Composable
fun FluxClipStudioApp(
    viewModel: OpenShortsViewModel,
    isTabletExpanded: Boolean = false,
    onExportSingleClipMediaStore: ((ClipItemUiModel) -> Unit)? = null
) {
    val uiState by viewModel.uiState.collectAsState()
    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()
    val selectedClip = uiState.clips.find { it.index == uiState.selectedClipIndex } ?: uiState.clips.firstOrNull()
    val handleExportClip: (ClipItemUiModel) -> Unit = { clip ->
        onExportSingleClipMediaStore?.invoke(clip)
        coroutineScope.launch {
            Toast.makeText(context, "Saving ${clip.label} to Gallery...", Toast.LENGTH_SHORT).show()
            val result = saveClipToGalleryMediaStore(context, clip)
            result.fold(
                onSuccess = {
                    Toast.makeText(context, "${clip.label} saved to Gallery (Movies/FluxClip)", Toast.LENGTH_LONG).show()
                },
                onFailure = { err ->
                    Toast.makeText(context, "Export failed: ${err.message}", Toast.LENGTH_LONG).show()
                }
            )
        }
    }

    // SAF File Pickers for Video, Transcript (.srt/.txt), and Master Audio (.mp3/.wav)
    val videoPickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        if (uri != null) {
            var fileName = "local_video.mp4"
            var fileSize = 0L
            context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (cursor.moveToFirst()) {
                    if (nameIndex != -1) fileName = cursor.getString(nameIndex)
                    if (sizeIndex != -1) fileSize = cursor.getLong(sizeIndex)
                }
            }
            viewModel.onLocalFilePicked(uri, fileName, fileSize, 0L)
        }
    }

    val transcriptPickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        if (uri != null) {
            var fileName = "transcript.srt"
            context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (cursor.moveToFirst() && nameIndex != -1) {
                    fileName = cursor.getString(nameIndex)
                }
            }
            val content = context.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() } ?: ""
            viewModel.onTranscriptSupplied(content, fileName)
        }
    }

    val audioPickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        if (uri != null) {
            var fileName = "master_audio.mp3"
            var fileSize = 0L
            context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (cursor.moveToFirst()) {
                    if (nameIndex != -1) fileName = cursor.getString(nameIndex)
                    if (sizeIndex != -1) fileSize = cursor.getLong(sizeIndex)
                }
            }
            val format = if (fileName.lowercase().endsWith(".wav")) "wav" else "mp3"
            viewModel.onMasterAudioSupplied(
                MasterAudioPayloadDto(
                    fileName = fileName,
                    format = format,
                    sizeBytes = fileSize,
                    durationMs = 0L,
                    uri = uri
                )
            )
        }
    }

    if (isTabletExpanded) {
        Row(
            modifier = Modifier
                .fillMaxSize()
                .background(Color(0xFFF6EAE5))
                .padding(24.dp),
            horizontalArrangement = Arrangement.spacedBy(24.dp, Alignment.CenterHorizontally)
        ) {
            Box(modifier = Modifier.weight(1f).fillMaxHeight()) {
                Screen1UploadsTab(
                    urlInput = uiState.urlInput,
                    onUrlChange = viewModel::onUrlInputChanged,
                    selectedFileName = uiState.selectedFileName,
                    onPickLocalVideo = { videoPickerLauncher.launch(arrayOf("video/*")) },
                    onClearLocalVideo = { viewModel.onLocalFilePicked(null) },
                    transcriptFileName = uiState.transcriptFileName,
                    onPickTranscript = { transcriptPickerLauncher.launch(arrayOf("text/plain", "application/x-subrip", "*/*")) },
                    onClearTranscript = { viewModel.onTranscriptSupplied("", null) },
                    masterAudio = uiState.masterAudio,
                    onPickAudio = { audioPickerLauncher.launch(arrayOf("audio/*")) },
                    onClearAudio = { viewModel.onMasterAudioSupplied(null) },
                    validationError = uiState.validationError,
                    isGenerating = uiState.isGenerating,
                    pipelineStage = uiState.pipelineStage,
                    onGenerateClips = viewModel::dispatchGenerateClips,
                    activeTab = FluxClipTab.UPLOADS,
                    onSelectTab = viewModel::onSelectTab
                )
            }
            Box(modifier = Modifier.weight(1f).fillMaxHeight()) {
                Screen2ClipsTab(
                    clips = uiState.clips,
                    selectedClip = selectedClip,
                    onSelectClip = viewModel::onSelectClip,
                    isPlaying = uiState.isPlaying,
                    onTogglePlay = viewModel::onTogglePlay,
                    onExportSingleClip = { selectedClip?.let(handleExportClip) },
                    activeTab = FluxClipTab.CLIPS,
                    onSelectTab = viewModel::onSelectTab
                )
            }
        }
    } else {
        when (uiState.activeTab) {
            FluxClipTab.UPLOADS -> Screen1UploadsTab(
                urlInput = uiState.urlInput,
                onUrlChange = viewModel::onUrlInputChanged,
                selectedFileName = uiState.selectedFileName,
                onPickLocalVideo = { videoPickerLauncher.launch(arrayOf("video/*")) },
                onClearLocalVideo = { viewModel.onLocalFilePicked(null) },
                transcriptFileName = uiState.transcriptFileName,
                onPickTranscript = { transcriptPickerLauncher.launch(arrayOf("text/plain", "application/x-subrip", "*/*")) },
                onClearTranscript = { viewModel.onTranscriptSupplied("", null) },
                masterAudio = uiState.masterAudio,
                onPickAudio = { audioPickerLauncher.launch(arrayOf("audio/*")) },
                onClearAudio = { viewModel.onMasterAudioSupplied(null) },
                validationError = uiState.validationError,
                isGenerating = uiState.isGenerating,
                pipelineStage = uiState.pipelineStage,
                onGenerateClips = viewModel::dispatchGenerateClips,
                activeTab = uiState.activeTab,
                onSelectTab = viewModel::onSelectTab
            )
            FluxClipTab.CLIPS -> Screen2ClipsTab(
                clips = uiState.clips,
                selectedClip = selectedClip,
                onSelectClip = viewModel::onSelectClip,
                isPlaying = uiState.isPlaying,
                onTogglePlay = viewModel::onTogglePlay,
                onExportSingleClip = { selectedClip?.let(handleExportClip) },
                activeTab = uiState.activeTab,
                onSelectTab = viewModel::onSelectTab
            )
        }
    }
}

@Composable
fun Screen1UploadsTab(
    urlInput: String,
    onUrlChange: (String) -> Unit,
    selectedFileName: String?,
    onPickLocalVideo: () -> Unit,
    onClearLocalVideo: () -> Unit,
    transcriptFileName: String?,
    onPickTranscript: () -> Unit,
    onClearTranscript: () -> Unit,
    masterAudio: MasterAudioPayloadDto?,
    onPickAudio: () -> Unit,
    onClearAudio: () -> Unit,
    validationError: String?,
    isGenerating: Boolean,
    pipelineStage: String?,
    onGenerateClips: () -> Unit,
    activeTab: FluxClipTab,
    onSelectTab: (FluxClipTab) -> Unit
) {
    Scaffold(
        bottomBar = {
            FluxClipBottomBar(activeTab = activeTab, onSelectTab = onSelectTab)
        },
        containerColor = SoftCoralBgTop
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(Brush.verticalGradient(listOf(SoftCoralBgTop, SoftCoralBgBottom)))
                .padding(innerPadding)
                .padding(horizontal = 24.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            // Top Bar
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = buildAnnotatedString {
                        withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = DeepWarmInk)) {
                            append("Flux")
                        }
                        withStyle(SpanStyle(fontWeight = FontWeight.Normal, color = Color(0xFFD45645))) {
                            append("Clip")
                        }
                    },
                    fontSize = 22.sp
                )
                IconButton(onClick = { /* Studio settings trigger */ }) {
                    Icon(
                        imageVector = Icons.Default.Settings,
                        contentDescription = "Settings",
                        tint = MutedWarmTaupe
                    )
                }
            }

            // Hero Section + Inputs
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text(
                    text = "Create.\nEdit. Share.",
                    fontFamily = FontFamily.Serif,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 38.sp,
                    lineHeight = 40.sp,
                    color = DeepWarmInk
                )
                Text(
                    text = "Turn any video into short, engaging clips.",
                    fontSize = 13.5.sp,
                    color = MutedWarmTaupe
                )

                // Remote URL Field (OutlinedTextField 56dp)
                OutlinedTextField(
                    value = urlInput,
                    onValueChange = onUrlChange,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp),
                    placeholder = { Text("Paste video URL • YouTube or direct MP4/MOV links", fontSize = 12.sp) },
                    leadingIcon = {
                        Icon(Icons.Default.Link, contentDescription = null, tint = MutedWarmTaupe)
                    },
                    trailingIcon = {
                        IconButton(onClick = onGenerateClips) {
                            Icon(
                                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                                contentDescription = "Submit URL",
                                tint = SoftCoralPrimaryEnd
                            )
                        }
                    },
                    shape = RoundedCornerShape(16.dp),
                    singleLine = true
                )

                // Local File Card
                Surface(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(64.dp)
                        .clickable { onPickLocalVideo() },
                    shape = RoundedCornerShape(16.dp),
                    color = SurfaceCardTint,
                    border = BorderStroke(1.dp, OutlineWarm)
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Icon(
                                imageVector = Icons.Default.CloudUpload,
                                contentDescription = null,
                                tint = SoftCoralPrimaryEnd
                            )
                            Column {
                                Text(
                                    text = selectedFileName ?: "Upload a video",
                                    fontWeight = FontWeight.SemiBold,
                                    fontSize = 13.5.sp,
                                    color = DeepWarmInk
                                )
                                Text("MP4, MOV & more formats", fontSize = 11.sp, color = MutedWarmTaupe)
                            }
                        }
                        if (selectedFileName != null) {
                            IconButton(onClick = onClearLocalVideo) {
                                Icon(Icons.Default.Close, contentDescription = "Remove video", tint = MutedWarmTaupe)
                            }
                        }
                    }
                }

                // Mandatory Transcript and Master Audio Pickers
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Surface(
                        modifier = Modifier
                            .weight(1f)
                            .height(48.dp)
                            .clickable { onPickTranscript() },
                        shape = RoundedCornerShape(12.dp),
                        color = SurfaceCardTint,
                        border = BorderStroke(1.dp, OutlineWarm)
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.weight(1f)) {
                                Icon(Icons.Default.Description, contentDescription = null, tint = SoftCoralPrimaryEnd, modifier = Modifier.size(16.dp))
                                Column {
                                    Text(transcriptFileName ?: "Transcript", fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = DeepWarmInk, maxLines = 1)
                                    Text(".srt or .txt", fontSize = 9.sp, color = MutedWarmTaupe)
                                }
                            }
                            if (transcriptFileName != null) {
                                IconButton(onClick = onClearTranscript, modifier = Modifier.size(20.dp)) {
                                    Icon(Icons.Default.Close, contentDescription = "Clear", tint = MutedWarmTaupe, modifier = Modifier.size(14.dp))
                                }
                            }
                        }
                    }

                    Surface(
                        modifier = Modifier
                            .weight(1f)
                            .height(48.dp)
                            .clickable { onPickAudio() },
                        shape = RoundedCornerShape(12.dp),
                        color = SurfaceCardTint,
                        border = BorderStroke(1.dp, OutlineWarm)
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.weight(1f)) {
                                Icon(Icons.Default.MusicNote, contentDescription = null, tint = SoftCoralPrimaryEnd, modifier = Modifier.size(16.dp))
                                Column {
                                    Text(masterAudio?.fileName ?: "Master Audio", fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = DeepWarmInk, maxLines = 1)
                                    Text(".mp3 or .wav", fontSize = 9.sp, color = MutedWarmTaupe)
                                }
                            }
                            if (masterAudio != null) {
                                IconButton(onClick = onClearAudio, modifier = Modifier.size(20.dp)) {
                                    Icon(Icons.Default.Close, contentDescription = "Clear", tint = MutedWarmTaupe, modifier = Modifier.size(14.dp))
                                }
                            }
                        }
                    }
                }

                // Inline validation error message
                if (validationError != null) {
                    Text(
                        text = validationError,
                        color = Color(0xFFC93B2B),
                        fontSize = 11.5.sp,
                        fontWeight = FontWeight.Medium,
                        modifier = Modifier.padding(horizontal = 4.dp)
                    )
                }
            }

            // Primary Action
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Button(
                    onClick = onGenerateClips,
                    enabled = !isGenerating,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp),
                    shape = CircleShape,
                    colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent),
                    contentPadding = PaddingValues()
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .background(
                                Brush.horizontalGradient(listOf(SoftCoralPrimaryStart, SoftCoralPrimaryEnd)),
                                shape = CircleShape
                            )
                            .padding(horizontal = 24.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = if (isGenerating && pipelineStage != null) pipelineStage else "Generate clips ›",
                            color = Color.White,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.Medium
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun Screen2ClipsTab(
    clips: List<ClipItemUiModel>,
    selectedClip: ClipItemUiModel?,
    onSelectClip: (ClipItemUiModel) -> Unit,
    isPlaying: Boolean,
    onTogglePlay: () -> Unit,
    onExportSingleClip: () -> Unit,
    activeTab: FluxClipTab,
    onSelectTab: (FluxClipTab) -> Unit
) {
    val context = LocalContext.current
    val exoPlayer = remember(context) {
        ExoPlayer.Builder(context).build()
    }

    LaunchedEffect(selectedClip?.videoUrl) {
        selectedClip?.videoUrl?.let { url ->
            exoPlayer.setMediaItem(MediaItem.fromUri(Uri.parse(url)))
            exoPlayer.prepare()
        }
    }

    LaunchedEffect(isPlaying) {
        if (isPlaying) exoPlayer.play() else exoPlayer.pause()
    }

    DisposableEffect(Unit) {
        onDispose {
            exoPlayer.release()
        }
    }

    Scaffold(
        bottomBar = {
            FluxClipBottomBar(activeTab = activeTab, onSelectTab = onSelectTab)
        },
        containerColor = SoftCoralBgTop
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(Brush.verticalGradient(listOf(SoftCoralBgTop, SoftCoralBgBottom)))
                .padding(innerPadding)
                .padding(horizontal = 24.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.SpaceBetween,
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Column(modifier = Modifier.fillMaxWidth()) {
                Text(
                    text = "Generated Clips",
                    fontFamily = FontFamily.Serif,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 35.sp,
                    color = DeepWarmInk
                )
                Spacer(modifier = Modifier.height(12.dp))
                if (clips.isNotEmpty()) {
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        items(clips) { clip ->
                            val selected = selectedClip?.index == clip.index
                            Column(
                                modifier = Modifier.clickable { onSelectClip(clip) },
                                horizontalAlignment = Alignment.Start
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(width = 76.dp, height = 52.dp)
                                        .clip(RoundedCornerShape(12.dp))
                                        .background(Color(0xFF1E1A1B))
                                        .border(
                                            width = if (selected) 2.dp else 1.dp,
                                            color = if (selected) SoftCoralPrimaryEnd else OutlineWarm,
                                            shape = RoundedCornerShape(12.dp)
                                        )
                                )
                                Spacer(modifier = Modifier.height(4.dp))
                                Text(
                                    text = clip.label,
                                    fontSize = 12.sp,
                                    fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
                                    color = if (selected) DeepWarmInk else MutedWarmTaupe
                                )
                            }
                        }
                    }
                } else {
                    Text(
                        text = "No clips generated yet",
                        fontSize = 12.sp,
                        color = MutedWarmTaupe
                    )
                }
            }

            // 9:16 Vertical Video Preview via ExoPlayer + Scrubber + Segment Metadata
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Box(
                    modifier = Modifier
                        .width(188.dp)
                        .aspectRatio(9f / 16f)
                        .clip(RoundedCornerShape(22.dp))
                        .background(Color(0xFF141213)),
                    contentAlignment = Alignment.BottomCenter
                ) {
                    if (selectedClip?.videoUrl != null) {
                        AndroidView(
                            factory = { ctx ->
                                PlayerView(ctx).apply {
                                    useController = false
                                    player = exoPlayer
                                }
                            },
                            update = { view ->
                                view.player = exoPlayer
                            },
                            modifier = Modifier.fillMaxSize()
                        )
                    }
                    if (selectedClip != null && selectedClip.videoUrl == null && selectedClip.caption.isNotBlank()) {
                        Text(
                            text = selectedClip.caption,
                            color = Color.White,
                            fontSize = 13.sp,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.padding(16.dp)
                        )
                    }
                }

                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    IconButton(onClick = onTogglePlay, enabled = selectedClip != null, modifier = Modifier.size(28.dp)) {
                        Icon(
                            imageVector = if (isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow,
                            contentDescription = "Play or pause",
                            tint = DeepWarmInk
                        )
                    }
                    Icon(
                        imageVector = Icons.Default.Stop,
                        contentDescription = null,
                        tint = MutedWarmTaupe,
                        modifier = Modifier.size(16.dp)
                    )
                    LinearProgressIndicator(
                        progress = {
                            if (selectedClip != null && selectedClip.durationSeconds > 0) {
                                selectedClip.currentSeconds.toFloat() / selectedClip.durationSeconds.toFloat()
                            } else {
                                0f
                            }
                        },
                        modifier = Modifier.weight(1f),
                        color = SoftCoralPrimaryEnd,
                        trackColor = OutlineWarm
                    )
                    Text(
                        text = if (selectedClip != null) "0:${selectedClip.currentSeconds} / 0:${selectedClip.durationSeconds}" else "0:00 / 0:00",
                        fontSize = 11.sp,
                        color = MutedWarmTaupe
                    )
                }

                Text(
                    text = if (selectedClip != null) {
                        "${selectedClip.label} • 9:16 vertical reframing\n${selectedClip.durationSeconds} seconds"
                    } else {
                        "No active clip selected"
                    },
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    color = DeepWarmInk,
                    textAlign = TextAlign.Center
                )
            }

            // Dual Export Actions: Inert Batch Export Zip Placeholder + Active Single Clip Export
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                // Strictly inert UI placeholder — no batch ZIP compression or multi-clip bundling
                OutlinedButton(
                    onClick = {},
                    enabled = false,
                    modifier = Modifier
                        .weight(1f)
                        .height(48.dp),
                    shape = CircleShape,
                    border = BorderStroke(1.dp, OutlineWarm)
                ) {
                    Text("Batch Export Zip ↓", fontSize = 12.sp, color = MutedWarmTaupe)
                }

                Button(
                    onClick = onExportSingleClip,
                    enabled = selectedClip != null,
                    modifier = Modifier
                        .weight(1f)
                        .height(48.dp),
                    shape = CircleShape,
                    colors = ButtonDefaults.buttonColors(containerColor = SoftCoralPrimaryEnd)
                ) {
                    Text("Export Clip ↓", fontSize = 13.sp, color = Color.White)
                }
            }
        }
    }
}

@Composable
fun FluxClipBottomBar(
    activeTab: FluxClipTab,
    onSelectTab: (FluxClipTab) -> Unit
) {
    NavigationBar(
        modifier = Modifier.height(56.dp),
        containerColor = Color(0xFFFAF0EC)
    ) {
        NavigationBarItem(
            selected = activeTab == FluxClipTab.UPLOADS,
            onClick = { onSelectTab(FluxClipTab.UPLOADS) },
            icon = { Icon(Icons.Default.Home, contentDescription = "Uploads") },
            label = { Text("Uploads", fontSize = 11.sp) }
        )
        NavigationBarItem(
            selected = activeTab == FluxClipTab.CLIPS,
            onClick = { onSelectTab(FluxClipTab.CLIPS) },
            icon = { Icon(Icons.Default.Movie, contentDescription = "Clips") },
            label = { Text("Clips", fontSize = 11.sp) }
        )
    }
}
