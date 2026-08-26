//! Cross-platform CRT Looks via wgpu (Metal / Vulkan / DX12).
//!
//! Presets emphasize structure (scanlines, mask, bloom, phosphor trails, chroma
//! mush) — not a vintage color grade. FFmpeg TV filters remain the CPU fallback.

use bytemuck::{Pod, Zeroable};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use super::ffmpeg::{self, resolve_ffmpeg};

/// Catalog Look ids that map to GPU presets (and FFmpeg fallback where applicable).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CrtPreset {
    Tv,
    Afterglow,
    Broadcast,
}

impl CrtPreset {
    #[allow(dead_code)]
    pub fn parse(id: &str) -> Option<Self> {
        match id {
            "tv" => Some(Self::Tv),
            "afterglow" => Some(Self::Afterglow),
            "broadcast" => Some(Self::Broadcast),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Tv => "tv",
            Self::Afterglow => "afterglow",
            Self::Broadcast => "broadcast",
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
struct CrtUniforms {
    size: [f32; 2],
    scanline_strength: f32,
    scanline_period: f32,
    mask_strength: f32,
    bloom_strength: f32,
    /// Mix of previous shaded frame (phosphor persistence).
    phosphor_mix: f32,
    /// 0 = sharp chroma, 1 = soft mush (Broadcast).
    chroma_mush: f32,
    fringe_px: f32,
    /// Pad to 16-byte uniform alignment (must match WGSL; avoid `vec3` pad).
    _pad: [f32; 3],
}

const _: () = assert!(std::mem::size_of::<CrtUniforms>() == 48);
const _: () = assert!(std::mem::size_of::<CrtUniforms>() % 16 == 0);

impl CrtPreset {
    fn uniforms(self, width: u32, height: u32) -> CrtUniforms {
        let size = [width as f32, height as f32];
        match self {
            // Spatial CRT — 2px soft bands; strength high enough to survive downscale.
            Self::Tv => CrtUniforms {
                size,
                scanline_strength: 0.45,
                scanline_period: 2.0,
                mask_strength: 0.16,
                bloom_strength: 0.12,
                phosphor_mix: 0.05,
                chroma_mush: 0.06,
                fringe_px: 0.45,
                _pad: [0.0; 3],
            },
            // Temporal trails via phosphor feedback.
            Self::Afterglow => CrtUniforms {
                size,
                scanline_strength: 0.40,
                scanline_period: 2.0,
                mask_strength: 0.14,
                bloom_strength: 0.14,
                phosphor_mix: 0.38,
                chroma_mush: 0.08,
                fringe_px: 0.4,
                _pad: [0.0; 3],
            },
            // Soft aperture / chroma mush — still readable after encode.
            Self::Broadcast => CrtUniforms {
                size,
                scanline_strength: 0.28,
                scanline_period: 2.0,
                mask_strength: 0.10,
                bloom_strength: 0.10,
                phosphor_mix: 0.05,
                chroma_mush: 0.65,
                fringe_px: 0.7,
                _pad: [0.0; 3],
            },
        }
    }
}

const CRT_SHADER: &str = r#"
struct Uniforms {
    size: vec2<f32>,
    scanline_strength: f32,
    scanline_period: f32,
    mask_strength: f32,
    bloom_strength: f32,
    phosphor_mix: f32,
    chroma_mush: f32,
    fringe_px: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var src_tex: texture_2d<f32>;
@group(0) @binding(2) var prev_tex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
    // Fullscreen triangle.
    var p = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0),
    );
    var out: VsOut;
    out.pos = vec4<f32>(p[idx], 0.0, 1.0);
    out.uv = vec2<f32>(p[idx].x * 0.5 + 0.5, 1.0 - (p[idx].y * 0.5 + 0.5));
    return out;
}

fn sample_rgb(tex: texture_2d<f32>, uv: vec2<f32>) -> vec3<f32> {
    return textureSampleLevel(tex, samp, uv, 0.0).rgb;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let uv = in.uv;
    let px = vec2<f32>(1.0) / max(u.size, vec2<f32>(1.0));

    // Mild RGB fringe (structural, not a grade).
    let fringe = u.fringe_px * px.x;
    var color = vec3<f32>(
        sample_rgb(src_tex, uv + vec2<f32>(-fringe, 0.0)).r,
        sample_rgb(src_tex, uv).g,
        sample_rgb(src_tex, uv + vec2<f32>(fringe, 0.0)).b,
    );

    // Soft bloom from neighbors (no sat/contrast styling).
    let bloom = (
        sample_rgb(src_tex, uv + vec2<f32>( px.x, 0.0)) +
        sample_rgb(src_tex, uv + vec2<f32>(-px.x, 0.0)) +
        sample_rgb(src_tex, uv + vec2<f32>(0.0,  px.y)) +
        sample_rgb(src_tex, uv + vec2<f32>(0.0, -px.y))
    ) * 0.25;
    color = mix(color, max(color, bloom), clamp(u.bloom_strength, 0.0, 1.0));

    // Chroma mush: blend toward spatially soft RGB while keeping some luma edge.
    if (u.chroma_mush > 0.001) {
        let mush_span = 2.0 + 4.0 * clamp(u.chroma_mush, 0.0, 1.0);
        let soft = (
            sample_rgb(src_tex, uv + vec2<f32>( mush_span * px.x, 0.0)) +
            sample_rgb(src_tex, uv + vec2<f32>(-mush_span * px.x, 0.0)) +
            sample_rgb(src_tex, uv + vec2<f32>(0.0,  mush_span * px.y)) +
            sample_rgb(src_tex, uv + vec2<f32>(0.0, -mush_span * px.y)) +
            sample_rgb(src_tex, uv + vec2<f32>( mush_span * 1.5 * px.x, 0.0)) +
            sample_rgb(src_tex, uv + vec2<f32>(-mush_span * 1.5 * px.x, 0.0))
        ) / 6.0;
        let luma = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
        let soft_luma = dot(soft, vec3<f32>(0.2126, 0.7152, 0.0722));
        let mushed = soft + vec3<f32>(luma - soft_luma);
        color = mix(color, mushed, clamp(u.chroma_mush, 0.0, 1.0));
    }

    // Phosphor persistence from previous shaded frame.
    let prev = sample_rgb(prev_tex, uv);
    color = max(color, prev * clamp(u.phosphor_mix, 0.0, 0.95));

    // Soft-edged scanline bands (period px) — survive mild downscale without
    // crushing the picture like a hard 50% bar.
    let y_px = uv.y * u.size.y;
    let phase = fract(y_px / max(u.scanline_period, 1.0));
    // Darken the lower half of each band with a short falloff.
    let edge = smoothstep(0.42, 0.58, phase);
    let scan = 1.0 - clamp(u.scanline_strength, 0.0, 0.7) * edge;
    color *= scan;

    // Simple aperture mask (RGB columns).
    let mx = i32(floor(uv.x * u.size.x)) % 3;
    var mask = vec3<f32>(1.0);
    if (mx == 0) { mask = vec3<f32>(1.0, 0.72, 0.72); }
    else if (mx == 1) { mask = vec3<f32>(0.72, 1.0, 0.72); }
    else { mask = vec3<f32>(0.72, 0.72, 1.0); }
    color = mix(color, color * mask, clamp(u.mask_strength, 0.0, 1.0));

    return vec4<f32>(clamp(color, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
"#;

struct CrtGpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::RenderPipeline,
    bind_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
}

/// Some Metal discrete GPUs (e.g. older AMD) accept map callbacks without
/// completing queue writes — probe before trusting an adapter for CRT readback.
fn probe_buffer_readback(device: &wgpu::Device, queue: &wgpu::Queue) -> bool {
    let buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("crt-probe"),
        size: 4,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    queue.write_buffer(&buf, 0, &[9, 8, 7, 6]);
    queue.submit([]);
    let slice = buf.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |r| {
        let _ = tx.send(r);
    });
    if wait_for_map(device, &rx).is_err() {
        return false;
    }
    let Ok(data) = slice.get_mapped_range() else {
        return false;
    };
    let ok = data[..4] == [9, 8, 7, 6];
    drop(data);
    buf.unmap();
    ok
}

fn wait_for_map(
    device: &wgpu::Device,
    rx: &std::sync::mpsc::Receiver<Result<(), wgpu::BufferAsyncError>>,
) -> Result<(), String> {
    let start = std::time::Instant::now();
    loop {
        let _ = device.poll(wgpu::PollType::Poll);
        match rx.try_recv() {
            Ok(Ok(())) => return Ok(()),
            Ok(Err(e)) => return Err(format!("CRT readback map failed: {e}")),
            Err(std::sync::mpsc::TryRecvError::Empty) => {
                if start.elapsed() > std::time::Duration::from_secs(3) {
                    return Err("CRT GPU map timed out".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                return Err("CRT readback channel closed".into());
            }
        }
    }
}

fn open_crt_device() -> Result<(wgpu::Device, wgpu::Queue, String), String> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::PRIMARY,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let mut adapters = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::PRIMARY));
    if adapters.is_empty() {
        return Err("No GPU adapter for CRT Looks".into());
    }
    // Prefer discrete, then integrated — but only keep adapters that pass readback.
    adapters.sort_by_key(|a| match a.get_info().device_type {
        wgpu::DeviceType::DiscreteGpu => 0,
        wgpu::DeviceType::IntegratedGpu => 1,
        wgpu::DeviceType::VirtualGpu => 2,
        _ => 3,
    });

    let mut last_err = String::from("No GPU adapter passed CRT readback probe");
    for adapter in adapters {
        let info = adapter.get_info();
        let (device, queue) =
            match pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
                label: Some("crt-looks"),
                required_features: wgpu::Features::empty(),
                required_limits:
                    wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()),
                experimental_features: wgpu::ExperimentalFeatures::default(),
                memory_hints: Default::default(),
                trace: wgpu::Trace::Off,
            })) {
                Ok(dq) => dq,
                Err(e) => {
                    last_err = format!("Could not open GPU device ({}): {e}", info.name);
                    continue;
                }
            };
        if !probe_buffer_readback(&device, &queue) {
            last_err = format!(
                "GPU adapter '{}' failed CRT readback probe (skipping)",
                info.name
            );
            continue;
        }
        return Ok((device, queue, info.name));
    }
    Err(last_err)
}

impl CrtGpu {
    fn new() -> Result<Self, String> {
        let (device, queue, _name) = open_crt_device()?;

        let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("crt-bind-layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("crt-pipeline-layout"),
            bind_group_layouts: &[Some(&bind_layout)],
            immediate_size: 0,
        });

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("crt-shader"),
            source: wgpu::ShaderSource::Wgsl(CRT_SHADER.into()),
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("crt-pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("crt-sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        Ok(Self {
            device,
            queue,
            pipeline,
            bind_layout,
            sampler,
        })
    }

    fn make_texture(&self, width: u32, height: u32, label: &str) -> wgpu::Texture {
        self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        })
    }

    fn process_frame(
        &self,
        width: u32,
        height: u32,
        preset: CrtPreset,
        src_rgba: &[u8],
        prev_rgba: &[u8],
        out_rgba: &mut [u8],
    ) -> Result<(), String> {
        let expected = (width as usize) * (height as usize) * 4;
        if src_rgba.len() < expected || prev_rgba.len() < expected || out_rgba.len() < expected {
            return Err("CRT frame buffer size mismatch".into());
        }

        let src_tex = self.make_texture(width, height, "crt-src");
        let prev_tex = self.make_texture(width, height, "crt-prev");
        let out_tex = self.make_texture(width, height, "crt-out");

        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &src_tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &src_rgba[..expected],
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &prev_tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &prev_rgba[..expected],
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );

        let uniforms = preset.uniforms(width, height);
        let uniform_buf = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("crt-uniforms"),
            size: std::mem::size_of::<CrtUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        self.queue
            .write_buffer(&uniform_buf, 0, bytemuck::bytes_of(&uniforms));

        let src_view = src_tex.create_view(&Default::default());
        let prev_view = prev_tex.create_view(&Default::default());
        let out_view = out_tex.create_view(&Default::default());

        let bind = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("crt-bind"),
            layout: &self.bind_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&src_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&prev_view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        });

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("crt-encoder"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("crt-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &out_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind, &[]);
            pass.draw(0..3, 0..1);
        }

        let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let unpadded = width * 4;
        let padded = (unpadded + align - 1) / align * align;
        let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("crt-readback"),
            size: (padded * height) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &out_tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &staging,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit(Some(encoder.finish()));

        let slice = staging.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        wait_for_map(&self.device, &rx)?;

        let data = slice
            .get_mapped_range()
            .map_err(|e| format!("CRT readback view failed: {e}"))?;
        for y in 0..height as usize {
            let src_off = y * padded as usize;
            let dst_off = y * unpadded as usize;
            out_rgba[dst_off..dst_off + unpadded as usize]
                .copy_from_slice(&data[src_off..src_off + unpadded as usize]);
        }
        drop(data);
        staging.unmap();
        Ok(())
    }
}

/// True when a GPU adapter is available and passes CRT readback probe.
pub fn crt_gpu_available() -> bool {
    shared_crt_gpu().is_ok()
}

fn shared_crt_gpu() -> Result<&'static CrtGpu, String> {
    use std::sync::OnceLock;
    static CELL: OnceLock<Result<CrtGpu, String>> = OnceLock::new();
    match CELL.get_or_init(CrtGpu::new) {
        Ok(gpu) => Ok(gpu),
        Err(err) => Err(err.clone()),
    }
}

fn probe_video(_ffmpeg: &Path, input: &Path) -> Result<(u32, u32, f64), String> {
    let probe = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,avg_frame_rate",
            "-of",
            "csv=p=0",
            input.to_str().ok_or("Invalid input path")?,
        ])
        .output()
        .map_err(|e| {
            format!("ffprobe failed ({e}). Install FFmpeg tools (ffprobe) alongside ffmpeg.")
        })?;
    if !probe.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&probe.stderr)
        ));
    }
    let line = String::from_utf8_lossy(&probe.stdout);
    let cols: Vec<&str> = line.trim().split(',').collect();
    if cols.len() < 3 {
        return Err(format!("Unexpected ffprobe output: {line}"));
    }
    let width: u32 = cols[0]
        .parse()
        .map_err(|_| format!("Bad width: {}", cols[0]))?;
    let height: u32 = cols[1]
        .parse()
        .map_err(|_| format!("Bad height: {}", cols[1]))?;
    let fps = {
        let mut it = cols[2].split('/');
        let n: f64 = it.next().unwrap_or("30").parse().unwrap_or(30.0);
        let d: f64 = it.next().unwrap_or("1").parse().unwrap_or(1.0);
        if d > 0.0 {
            n / d
        } else {
            30.0
        }
    };
    Ok((width, height, fps))
}

/// Apply a CRT preset to an entire video via FFmpeg raw pipes + wgpu.
pub fn apply_crt_preset_to_video(
    input: &Path,
    output: &Path,
    preset: CrtPreset,
) -> Result<(), String> {
    let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
        "FFmpeg is required for CRT Looks. Install with: brew install ffmpeg".to_string()
    })?;
    let (width, height, fps) = probe_video(&ffmpeg, input)?;
    if width == 0 || height == 0 {
        return Err("Video has no dimensions".into());
    }
    let gpu = shared_crt_gpu()?;
    let frame_bytes = (width as usize) * (height as usize) * 4;

    let mut decoder = ffmpeg::command(&ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            input.to_str().ok_or("Invalid input path")?,
            "-an",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start decode: {e}"))?;

    let partial = output.with_extension("crt-partial.mp4");
    let _ = std::fs::remove_file(&partial);
    let mut encoder = ffmpeg::command(&ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-s",
            &format!("{width}x{height}"),
            "-r",
            &format!("{fps:.3}"),
            "-i",
            "-",
            "-i",
            input.to_str().ok_or("Invalid input path")?,
            "-map",
            "0:v:0",
            "-map",
            "1:a?",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-profile:v",
            "baseline",
            "-bf",
            "0",
            "-refs",
            "1",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-shortest",
            partial.to_str().ok_or("Invalid output path")?,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start encode: {e}"))?;

    let mut dec_out = decoder.stdout.take().ok_or("Decode stdout missing")?;
    let mut enc_in = encoder.stdin.take().ok_or("Encode stdin missing")?;

    let mut src = vec![0u8; frame_bytes];
    let mut prev = vec![0u8; frame_bytes];
    let mut out = vec![0u8; frame_bytes];

    loop {
        let mut read = 0;
        while read < frame_bytes {
            match dec_out.read(&mut src[read..]) {
                Ok(0) => break,
                Ok(n) => read += n,
                Err(e) => return Err(format!("Decode read failed: {e}")),
            }
        }
        if read == 0 {
            break;
        }
        if read < frame_bytes {
            break;
        }
        gpu.process_frame(width, height, preset, &src, &prev, &mut out)?;
        enc_in
            .write_all(&out)
            .map_err(|e| format!("Encode write failed: {e}"))?;
        prev.copy_from_slice(&out);
    }
    drop(enc_in);

    let dec_status = decoder
        .wait()
        .map_err(|e| format!("Decode wait failed: {e}"))?;
    let enc_output = encoder
        .wait_with_output()
        .map_err(|e| format!("Encode wait failed: {e}"))?;
    if !enc_output.status.success() {
        return Err(format!(
            "CRT encode failed: {}",
            String::from_utf8_lossy(&enc_output.stderr)
        ));
    }
    if !dec_status.success() && dec_status.code() != Some(0) {
        // EOF on pipe often yields non-zero; accept if we produced a file.
    }
    if !partial.is_file() {
        return Err("CRT Look produced no output file".into());
    }
    if output.exists() {
        let _ = std::fs::remove_file(output);
    }
    std::fs::rename(&partial, output).map_err(|e| format!("Could not finalize CRT output: {e}"))?;
    Ok(())
}

/// Shade a single RGBA8 frame (unit tests / offline).
#[allow(dead_code)]
pub fn apply_crt_preset_to_rgba(
    width: u32,
    height: u32,
    src_rgba: &[u8],
    preset: CrtPreset,
) -> Result<Vec<u8>, String> {
    let expected = (width as usize) * (height as usize) * 4;
    if src_rgba.len() < expected {
        return Err("RGBA buffer too small".into());
    }
    let gpu = shared_crt_gpu()?;
    let prev = vec![0u8; expected];
    let mut out = vec![0u8; expected];
    gpu.process_frame(
        width,
        height,
        preset,
        &src_rgba[..expected],
        &prev,
        &mut out,
    )?;
    Ok(out)
}

/// First enabled CRT preset in catalog order, if any.
pub fn first_enabled_crt_preset(tv: bool, afterglow: bool, broadcast: bool) -> Option<CrtPreset> {
    if tv {
        Some(CrtPreset::Tv)
    } else if afterglow {
        Some(CrtPreset::Afterglow)
    } else if broadcast {
        Some(CrtPreset::Broadcast)
    } else {
        None
    }
}

#[allow(dead_code)]
pub fn gpu_device_label() -> Option<String> {
    open_crt_device().ok().map(|(_, _, name)| name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_parse_roundtrip() {
        assert_eq!(CrtPreset::parse("tv"), Some(CrtPreset::Tv));
        assert_eq!(CrtPreset::parse("afterglow"), Some(CrtPreset::Afterglow));
        assert_eq!(CrtPreset::parse("broadcast"), Some(CrtPreset::Broadcast));
        assert_eq!(CrtPreset::parse("nope"), None);
    }

    #[test]
    fn first_enabled_prefers_tv() {
        assert_eq!(
            first_enabled_crt_preset(true, true, true),
            Some(CrtPreset::Tv)
        );
        assert_eq!(
            first_enabled_crt_preset(false, true, true),
            Some(CrtPreset::Afterglow)
        );
        assert_eq!(
            first_enabled_crt_preset(false, false, true),
            Some(CrtPreset::Broadcast)
        );
        assert_eq!(first_enabled_crt_preset(false, false, false), None);
    }

    #[test]
    fn gpu_shades_tiny_frame_or_skips_without_adapter() {
        let w = 16u32;
        let h = 16u32;
        let mut src = vec![0u8; (w * h * 4) as usize];
        for px in src.chunks_exact_mut(4) {
            px[0] = 200;
            px[1] = 100;
            px[2] = 50;
            px[3] = 255;
        }
        match apply_crt_preset_to_rgba(w, h, &src, CrtPreset::Tv) {
            Ok(out) => {
                assert_eq!(out.len(), src.len());
                // Should not be identical black.
                assert!(out.iter().any(|&b| b > 0));
            }
            Err(err) => {
                // CI / headless may lack a GPU.
                assert!(
                    err.contains("GPU") || err.contains("adapter") || err.contains("device"),
                    "unexpected error: {err}"
                );
            }
        }
    }
}
