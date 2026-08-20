#!/usr/bin/env python3
"""h3box — MiniMax-H3 视频 + NoobAI/Anima 生图的本地 GPU 盒子产线 CLI。

featurize 5090 开荒配方（2026-08-08）固化版；换机器/换账号照下面三步即可复活：

  1) 租机（featurize 5090，选预制 comfyui 环境的镜像），本机执行:
       scp -P <端口> h3box.py <用户>@<主机>:~/
  2) 盒子上执行（幂等，断了重跑接着走；全程 ~40 分钟，大头是 44G 权重+sage 编译）:
       python3 ~/h3box.py setup
  3) 起服务器并体检:
       python3 ~/h3box.py server start
       python3 ~/h3box.py doctor

日常:
  python3 h3box.py video jobs.json                        # 跑批（字段同 Modal 版 h3_comfy.py）
  python3 h3box.py video -p "..." --duration 8 --name t1  # 单条
  python3 h3box.py image -p "1girl, ..." --model noobai   # 生图（danbooru 标签）
  python3 h3box.py image -p "a girl ..." --model anima    # 生图（自然语言；非商用许可）
  python3 h3box.py server start --mode sage3              # fp4 档，仅限 ≤8s 视频任务
  python3 h3box.py models / doctor / server status|log|stop

换机器只需要覆盖环境变量（或直接改下面的默认值）:
  H3BOX_PY / H3BOX_CONDA / H3BOX_COMFY / H3BOX_OUT / H3BOX_PORT / HF_ENDPOINT / H3BOX_PIP_INDEX
"""
import argparse
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

# ---------- 配置（featurize 预制 comfyui 环境的默认值；换平台用环境变量覆盖） ----------
ENV_PY = os.environ.get("H3BOX_PY", "/environment/miniconda3/envs/comfyui/bin/python")
CONDA = os.environ.get("H3BOX_CONDA", "/environment/miniconda3/bin/conda")
ENV_NAME = os.environ.get("H3BOX_ENV", "comfyui")
COMFY = pathlib.Path(os.environ.get("H3BOX_COMFY", "~/ComfyUI")).expanduser()
OUT_DIR = pathlib.Path(os.environ.get("H3BOX_OUT", "~/outputs")).expanduser()
PORT = int(os.environ.get("H3BOX_PORT", "8188"))
HF_ENDPOINT = os.environ.get("HF_ENDPOINT", "https://hf-mirror.com")  # 国内盒子默认走镜像
PIP_INDEX = os.environ.get("H3BOX_PIP_INDEX", "https://pypi.tuna.tsinghua.edu.cn/simple")
SAGE_DIR = pathlib.Path.home() / "SageAttention"
STATE_FILE = pathlib.Path.home() / ".h3box_state.json"
LOG_FILE = pathlib.Path.home() / "comfy.log"
STAGING = pathlib.Path.home() / ".h3box_dl"

# ---------- 权重清单（repo, 仓内路径, models/ 下的目标子目录） ----------
MODELS = [
    # MiniMax-H3 fp8 套装（32G 显存档，质量对 bf16 帧级零损）
    ("Comfy-Org/MiniMax-H3", "diffusion_models/minimax_h3_fl2va_pruned_fp8_scaled.safetensors", "diffusion_models"),
    ("Comfy-Org/MiniMax-H3", "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "text_encoders"),
    ("Comfy-Org/MiniMax-H3", "vae/minimax_h3_video_vae_fp16.safetensors", "vae"),
    ("Comfy-Org/MiniMax-H3", "vae/minimax_h3_audio_vae_fp32.safetensors", "vae"),
    ("drbaph/MiniMax-H3-Turbo-Lora-ComfyUI", "minimax_h3_turbo_4step_ema_ckpt850_pruned_comfyui.safetensors", "loras"),
    # 生图 SDXL 动漫线。⚠️ 许可：NoobAI 禁止任何形式商业化（**含生成物**），Pony 禁止
    # 在任何货币化站点/应用上跑推理 —— 两者都只能站主自用，商用关键帧别用它们。
    # （08-11 前这里写着"宽松许可，商用关键帧用它"，是错的，已查实更正。）
    ("Laxhar/noobai-XL-Vpred-1.0", "NoobAI-XL-Vpred-v1.0.safetensors", "checkpoints"),
    ("Laxhar/noobai-XL-1.1", "NoobAI-XL-v1.1.safetensors", "checkpoints"),
    ("AstraliteHeart/pony-diffusion-v6", "v6.safetensors", "checkpoints",
     "ponyDiffusionV6XL.safetensors"),
    # Civitai 上的 LoRA 进不了这张表：盒子直连 civitai.com 被 TLS 重置（GFW），
    # 只能本机下好再 scp 推上来。清单与用法见 paint-still-cookbook.md。
    # 生图：Krea 2 Turbo（12B 审美向底模，反 AI 油光脸；个人/小团队免费。
    # DiT 取 bf16 满血 24G——32G 卡装得下就不吃量化；TE 4B 取 fp8 官方推荐档。
    # 08-08 FLUX.2 已下架：32G 卡装卸税重 + 用户实测效果差（弱区=二次元/成人向）
    ("Comfy-Org/Krea-2", "diffusion_models/krea2_turbo_bf16.safetensors", "diffusion_models"),
    ("Comfy-Org/Krea-2", "text_encoders/qwen3vl_4b_fp8_scaled.safetensors", "text_encoders"),
    # Krea 2 官方风格 LoRA 全家桶（只配 krea2 模型；用法 --lora <名> --lora-strength 0.6-0.8）
    ("Comfy-Org/Krea-2", "loras/krea2_darkbrush.safetensors", "loras"),
    ("Comfy-Org/Krea-2", "loras/krea2_dotmatrix.safetensors", "loras"),
    ("Comfy-Org/Krea-2", "loras/krea2_kidsdrawing.safetensors", "loras"),
    ("Comfy-Org/Krea-2", "loras/krea2_neondrip.safetensors", "loras"),
    ("Comfy-Org/Krea-2", "loras/krea2_rainywindow.safetensors", "loras"),
    ("Comfy-Org/Krea-2", "loras/krea2_retroanime.safetensors", "loras"),
    ("Comfy-Org/Krea-2", "loras/krea2_softwatercolor.safetensors", "loras"),
    ("Comfy-Org/Krea-2", "loras/krea2_sunsetblur.safetensors", "loras"),
    ("Comfy-Org/Krea-2", "loras/krea2_vintagetarot.safetensors", "loras"),
    # 生图：Anima（自然语言，2B，非商用许可）
    ("circlestone-labs/Anima", "split_files/diffusion_models/anima-aesthetic-v1.1.safetensors", "diffusion_models"),
    ("circlestone-labs/Anima", "split_files/diffusion_models/anima-turbo-v1.0.safetensors", "diffusion_models"),
    ("circlestone-labs/Anima", "split_files/text_encoders/qwen_3_06b_base.safetensors", "text_encoders"),
    ("circlestone-labs/Anima", "split_files/vae/qwen_image_vae.safetensors", "vae"),
]

CLIP_NAME = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
VIDEO_VAE = "minimax_h3_video_vae_fp16.safetensors"
AUDIO_VAE = "minimax_h3_audio_vae_fp32.safetensors"
DEFAULT_UNET = "minimax_h3_fl2va_pruned_fp8_scaled.safetensors"
TURBO_LORA = "minimax_h3_turbo_4step_ema_ckpt850_pruned_comfyui.safetensors"
QUALITY_PRESETS = {"turbo": {"steps": 8, "lora": TURBO_LORA}, "full": {"steps": 50, "lora": None}}

# 生图预设（参数为 08-08 实测配方）
T2I_PRESETS = {
    # NoobAI V-Pred 1.0（08-11 起的默认档）。v-pred 不是"版本号"是另一套预测目标：
    # 必须 euler（**不是 euler_ancestral**，官方指南明说 Euler A 会过饱和）+ cfg 4-5
    # + ModelSamplingDiscrete(v_prediction)。三样缺一出废图，且不报错。
    # 负面提示词按站主用途剔掉了官方模板里的 nsfw / furry 系词。
    "noobai": {
        "kind": "ckpt", "ckpt": "NoobAI-XL-Vpred-v1.0.safetensors",
        "steps": 30, "cfg": 4.5, "sampler": "euler", "scheduler": "normal",
        "latent": "EmptyLatentImage", "v_pred": True,
        "qual_prefix": "masterpiece, best quality, newest, absurdres, highres, ",
        "neg": ("worst quality, old, early, low quality, lowres, signature, username, "
                "logo, bad hands, mutated hands, extra digits, watermark, jpeg artifacts"),
    },
    # eps 线保留：LoRA 生态大量是对着 eps 训的，v-pred 版拿 eps LoRA 会发灰/过饱和，
    # 遇到只有 eps 版的 LoRA 就切到这一档跑。
    "noobai-eps": {
        "kind": "ckpt", "ckpt": "NoobAI-XL-v1.1.safetensors",
        "steps": 28, "cfg": 5.5, "sampler": "euler_ancestral", "scheduler": "normal",
        "latent": "EmptyLatentImage",
        "qual_prefix": "masterpiece, best quality, newest, absurdres, highres, ",
        "neg": ("worst quality, low quality, bad anatomy, bad hands, extra digits, "
                "watermark, signature, text, jpeg artifacts"),
    },
    # Pony V6 XL：**强制 clip skip 2**，官方原话 "otherwise you will be getting low
    # quality blobs" —— 少了这个不报错，直接出糊团。质量前缀必须是完整六段串：
    # 官方承认训练时踩了 Clever Hans，模型学的是整串而不是单个 score_N，
    # 只写 score_9 效果弱得多。官方称通常不需要负面提示词。
    "pony": {
        "kind": "ckpt", "ckpt": "ponyDiffusionV6XL.safetensors",
        "steps": 25, "cfg": 7.0, "sampler": "euler_ancestral", "scheduler": "normal",
        "latent": "EmptyLatentImage", "clip_skip": -2,
        "qual_prefix": ("score_9, score_8_up, score_7_up, score_6_up, score_5_up, "
                        "score_4_up, "),
        "neg": "score_6, score_5, score_4, worst quality, low quality, watermark, signature",
    },
    "anima": {
        "kind": "split", "unet": "anima-aesthetic-v1.1.safetensors",
        "te": "qwen_3_06b_base.safetensors", "te_type": "cosmos", "vae": "qwen_image_vae.safetensors",
        "steps": 28, "cfg": 4.0, "sampler": "euler", "scheduler": "simple",
        "latent": "EmptySD3LatentImage", "qual_prefix": "",
        "neg": "worst quality, blurry, watermark, text",
    },
    # Krea 2 Turbo（个人免费）：自然语言审美向；8 步蒸馏 cfg 1；
    # CLIPLoader type=krea2 + Qwen VAE + SD3 潜变量（与 anima 同族布局）
    "krea2": {
        "kind": "split", "unet": "krea2_turbo_bf16.safetensors",
        "te": "qwen3vl_4b_fp8_scaled.safetensors", "te_type": "krea2",
        "vae": "qwen_image_vae.safetensors",
        "steps": 8, "cfg": 1.0, "sampler": "euler", "scheduler": "simple",
        "latent": "EmptySD3LatentImage", "qual_prefix": "",
        "neg": "",
    },
    # 实验档：蒸馏版，低步数低 cfg；效果没细验过，参数可 --steps/--cfg 覆盖
    "anima-turbo": {
        "kind": "split", "unet": "anima-turbo-v1.0.safetensors",
        "te": "qwen_3_06b_base.safetensors", "te_type": "cosmos", "vae": "qwen_image_vae.safetensors",
        "steps": 8, "cfg": 1.0, "sampler": "euler", "scheduler": "simple",
        "latent": "EmptySD3LatentImage", "qual_prefix": "",
        "neg": "worst quality, blurry, watermark, text",
    },
}

# sage3 fp4 补丁（ComfyUI 原生带内核但默认选择链没有分支；H3_SAGE3=1 时优先走）
# 锚点必须带第二行：裸的 sage_attention_enabled() 在 master 出现两次（31 行 ImportError 分支/855 行全局选择），replace 取首个会插错位
PATCH_ANCHOR = '''if model_management.sage_attention_enabled():
    logging.info("Using sage attention")'''
PATCH_BLOCK = '''import os as _os
if SAGE_ATTENTION3_IS_AVAILABLE and _os.environ.get("H3_SAGE3") == "1":
    logging.info("Using sage attention 3 (fp4 blackwell)")
    optimized_attention = attention3_sage
elif model_management.sage_attention_enabled():
    logging.info("Using sage attention")'''


def say(msg):
    print(msg, flush=True)


def run(cmd, check=True, env=None, cwd=None):
    say(f"  $ {cmd if isinstance(cmd, str) else ' '.join(cmd)}")
    e = dict(os.environ)
    if env:
        e.update(env)
    return subprocess.run(cmd, shell=isinstance(cmd, str), check=check, env=e, cwd=cwd)


def state_load():
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {}


def state_save(d):
    STATE_FILE.write_text(json.dumps(d))


def api(path, payload=None, timeout=30):
    url = f"http://127.0.0.1:{PORT}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        # ComfyUI 的 400 正文里带着到底哪个节点哪个字段不合法。原来直接把这段吞了，
        # 只剩一句 "HTTP Error 400"，等于闭着眼睛猜（08-11 为此浪费两轮）。
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")
        except Exception:
            pass
        raise SystemExit(f"ComfyUI {e.code} on {path}:\n{body[:2500]}") from None


def server_up():
    try:
        api("/system_stats", timeout=5)
        return True
    except Exception:
        return False


def frame_count(duration_s: float) -> int:
    f = max(5, round(duration_s * 24))
    return f + (5 - (f % 17)) % 17


# ====================================================================== setup
def sage_build_env():
    """sage2/sage3 编译工具链（四打才成的配方，一字别动）：
    conda gcc13 + nvcc 走 conda + CPATH 指到 conda CUDA 头文件 + 只编 sm_120。"""
    bin_ = pathlib.Path(ENV_PY).parent
    return {
        "CC": str(bin_ / "x86_64-conda-linux-gnu-cc"),
        "CXX": str(bin_ / "x86_64-conda-linux-gnu-g++"),
        "NVCC_PREPEND_FLAGS": f"-ccbin {bin_ / 'x86_64-conda-linux-gnu-g++'}",
        "CPATH": str(bin_.parent / "targets/x86_64-linux/include"),
        "CUDA_HOME": str(bin_.parent),
        "TORCH_CUDA_ARCH_LIST": "12.0",
        "MAX_JOBS": str(os.cpu_count() or 8),
    }


def env_import_ok(module):
    return subprocess.run([ENV_PY, "-c", f"import {module}"],
                          capture_output=True).returncode == 0


def phase_deps(force=False):
    say("[deps] 基础依赖（huggingface_hub + hf_transfer）")
    run([ENV_PY, "-m", "pip", "install", "-q", "-i", PIP_INDEX, "huggingface_hub", "hf_transfer"])


def phase_comfy(force=False):
    say("[comfy] ComfyUI 更新到 master（预制版通常太旧没有 H3 节点）")
    if not COMFY.exists():
        run(["git", "clone", "https://github.com/comfyanonymous/ComfyUI.git", str(COMFY)])
    marker = any("MiniMaxH3ImageToVideo" in p.read_text(errors="ignore")
                 for p in (COMFY / "comfy_extras").glob("nodes_*.py")) if (COMFY / "comfy_extras").exists() else False
    if marker and not force:
        say("  [SKIP] 已有 H3 节点")
        return
    run(["git", "fetch", "origin", "master"], cwd=COMFY)
    run(["git", "checkout", "-f", "FETCH_HEAD"], cwd=COMFY)
    run([ENV_PY, "-m", "pip", "install", "-q", "-i", PIP_INDEX, "-r", str(COMFY / "requirements.txt")])


def phase_models(force=False):
    say(f"[models] 权重下载（endpoint={HF_ENDPOINT}，共 {len(MODELS)} 件 ~51G，实测 60-80MB/s）")
    STAGING.mkdir(exist_ok=True)
    for entry in MODELS:
        repo, fname, sub = entry[0], entry[1], entry[2]
        # 可选第 4 项 = 落盘改名（上游文件名太泛时用，如 pony 的 v6.safetensors）
        target = COMFY / "models" / sub / (entry[3] if len(entry) > 3 else pathlib.Path(fname).name)
        if target.exists() and not force:
            say(f"  [SKIP] {target.name}")
            continue
        say(f"  [DL] {repo} :: {fname}")
        code = (
            "import os\n"
            "os.environ['HF_HUB_ENABLE_HF_TRANSFER']='1'\n"
            f"os.environ.setdefault('HF_ENDPOINT','{HF_ENDPOINT}')\n"
            "from huggingface_hub import hf_hub_download\n"
            f"print(hf_hub_download({repo!r}, {fname!r}, local_dir={str(STAGING)!r}))\n"
        )
        r = subprocess.run([ENV_PY, "-c", code], capture_output=True, text=True)
        if r.returncode != 0:
            raise SystemExit(f"下载失败 {fname}:\n{r.stderr[-2000:]}")
        got = pathlib.Path(r.stdout.strip().splitlines()[-1])
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(got), str(target))
        say(f"  [OK] {target.name} {target.stat().st_size / 1e9:.1f}G")


def phase_sage(force=False):
    say("[sage] SageAttention 2.x sm_120 编译（产线默认内核，8s 步时对 SDPA 砍半）")
    if env_import_ok("sageattention") and not force:
        say("  [SKIP] sageattention 已可导入")
        return
    say("  conda 工具链（gcc13 + nvcc13；预制 env 没有编译器）")
    run([CONDA, "install", "-n", ENV_NAME, "-c", "conda-forge",
         "gcc_linux-64=13", "gxx_linux-64=13", "-y"])
    run([CONDA, "install", "-n", ENV_NAME, "-c", "nvidia", "cuda-toolkit=13.*", "-y"])
    if not SAGE_DIR.exists():
        run(["git", "clone", "https://github.com/thu-ml/SageAttention.git", str(SAGE_DIR)])
    run([ENV_PY, "-m", "pip", "install", "--no-build-isolation", "."],
        env=sage_build_env(), cwd=SAGE_DIR)
    say("  [OK] SAGE_BUILD_DONE")


def phase_sage3(force=False):
    say("[sage3] SageAttention3 fp4 blackwell 编译（仅 ≤8s 任务的提速档）")
    if env_import_ok("sageattn3") and not force:
        say("  [SKIP] sageattn3 已可导入")
        return
    sub = SAGE_DIR / "sageattention3_blackwell"
    if not sub.exists():
        raise SystemExit("先跑 --only sage（需要 SageAttention 仓库）")
    # torch 2.11 头文件要 c++20，setup.py 写死 c++17 必炸——sed 是真解
    run(f"sed -i 's/c++17/c++20/g' {sub / 'setup.py'}")
    run([ENV_PY, "-m", "pip", "install", "--no-build-isolation", "."],
        env=sage_build_env(), cwd=sub)
    say("  [OK] SAGE3_BUILD_DONE")


def phase_patch(force=False):
    say("[patch] attention.py 加 H3_SAGE3=1 选择分支")
    f = COMFY / "comfy/ldm/modules/attention.py"
    src = f.read_text()
    if "H3_SAGE3" in src:
        say("  [SKIP] 补丁已在")
        return
    if "SAGE_ATTENTION3_IS_AVAILABLE" not in src or PATCH_ANCHOR not in src:
        say("  [WARN] ComfyUI 结构变了（找不到锚点），跳过 sage3 补丁——sage2 不受影响")
        return
    f.write_text(src.replace(PATCH_ANCHOR, PATCH_BLOCK, 1))
    say("  [OK] 已打补丁")


PHASES = [("deps", phase_deps), ("comfy", phase_comfy), ("models", phase_models),
          ("sage", phase_sage), ("sage3", phase_sage3), ("patch", phase_patch)]


def cmd_setup(args):
    for name, fn in PHASES:
        if args.only and name != args.only:
            continue
        fn(force=args.force)
    say("SETUP_DONE — 接着: python3 h3box.py server start && python3 h3box.py doctor")


# ====================================================================== server
def cmd_server(args):
    st = state_load()
    if args.action == "start":
        if server_up():
            say(f"已在跑（mode={st.get('mode', '未知')}）；要换档先 stop")
            return
        mode = args.mode
        flags = [] if mode == "sdpa" else ["--use-sage-attention"]
        if os.environ.get("H3_HIGHVRAM"):  # 96G 级卡专用：全家常驻显存，免逐件装卸；32G 卡开必 OOM
            flags.append("--highvram")
        env = dict(os.environ)
        if mode == "sage3":
            env["H3_SAGE3"] = "1"
        log = open(LOG_FILE, "ab")
        p = subprocess.Popen(
            [ENV_PY, "main.py", "--listen", "127.0.0.1", "--port", str(PORT)] + flags,
            cwd=COMFY, stdout=log, stderr=log, env=env, start_new_session=True)
        state_save({**st, "mode": mode, "pid": p.pid})
        say(f"启动中 pid={p.pid} mode={mode} …")
        for _ in range(60):
            time.sleep(2)
            if server_up():
                say(f"SERVER_UP mode={mode} port={PORT}")
                return
        raise SystemExit(f"120s 未起来，看日志: python3 h3box.py server log")
    if args.action == "stop":
        pid = st.get("pid")
        killed = False
        if pid:
            try:
                os.killpg(os.getpgid(pid), signal.SIGTERM)
                killed = True
            except (ProcessLookupError, PermissionError):
                pass
        if not killed:
            subprocess.run(["pkill", "-f", "main.py --listen"], check=False)
        say("SERVER_STOPPED")
        return
    if args.action == "status":
        if not server_up():
            say("DOWN")
            return
        s = api("/system_stats")
        dev = s["devices"][0]
        say(f"UP mode={st.get('mode', '未知(state缺失)')} port={PORT}")
        say(f"GPU: {dev['name']}  显存 {dev['vram_free'] / 1e9:.1f}G 空闲 / {dev['vram_total'] / 1e9:.1f}G")
        q = api("/queue")
        say(f"队列: 跑动 {len(q['queue_running'])} / 排队 {len(q['queue_pending'])}")
        return
    if args.action == "log":
        subprocess.run(["tail", "-n", str(args.lines), str(LOG_FILE)])


# ====================================================================== video
def build_workflow(job: dict) -> dict:
    unet = job.get("unet", DEFAULT_UNET)
    preset = QUALITY_PRESETS[job.get("quality", "turbo")]
    steps = job.get("steps", preset["steps"])
    lora = job.get("lora", preset["lora"])
    model_ref = ["unet", 0]

    wf = {
        "unet": {"class_type": "UNETLoader",
                 "inputs": {"unet_name": unet,
                            "weight_dtype": job.get("weight_dtype", "default")}},
        "clip": {"class_type": "CLIPLoader",
                 "inputs": {"clip_name": CLIP_NAME, "type": "minimax", "device": "default"}},
        "vaev": {"class_type": "VAELoader", "inputs": {"vae_name": VIDEO_VAE}},
        "vaea": {"class_type": "VAELoader", "inputs": {"vae_name": AUDIO_VAE}},
    }
    if lora:
        wf["lora"] = {"class_type": "LoraLoaderModelOnly",
                      "inputs": {"model": model_ref, "lora_name": lora,
                                 "strength_model": job.get("lora_strength", 1.0)}}
        model_ref = ["lora", 0]

    cond_inputs = {"clip": ["clip", 0], "vae": ["vaev", 0],
                   "prompt": job["prompt"],
                   "width": job.get("width", 1344),
                   "height": job.get("height", 768),
                   "length": frame_count(job.get("duration", 5.0))}
    for slot in ("first_frame", "last_frame"):
        p = job.get(slot)
        if p:
            src = pathlib.Path(p).expanduser()
            if not src.exists():
                raise SystemExit(f"{slot} 不存在: {src}")
            dest = COMFY / "input" / src.name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(src, dest)  # 永远覆盖: 同名锚帧缓存事故 08-10
            wf[slot] = {"class_type": "LoadImage", "inputs": {"image": src.name}}
            cond_inputs[slot] = [slot, 0]

    wf.update({
        "cond": {"class_type": "MiniMaxH3ImageToVideo", "inputs": cond_inputs},
        "noise": {"class_type": "RandomNoise",
                  "inputs": {"noise_seed": job.get("seed", 1101)}},
        "sampler_sel": {"class_type": "KSamplerSelect",
                        "inputs": {"sampler_name": "res_multistep"}},
        "sched": {"class_type": "BasicScheduler",
                  "inputs": {"model": model_ref, "scheduler": "simple",
                             "steps": steps, "denoise": 1.0}},
        "guider": {"class_type": "BasicGuider",
                   "inputs": {"model": model_ref, "conditioning": ["cond", 0]}},
        "sample": {"class_type": "SamplerCustomAdvanced",
                   "inputs": {"noise": ["noise", 0], "guider": ["guider", 0],
                              "sampler": ["sampler_sel", 0], "sigmas": ["sched", 0],
                              "latent_image": ["cond", 1]}},
        "decv": {"class_type": "VAEDecode",
                 "inputs": {"samples": ["sample", 0], "vae": ["vaev", 0]}},
        "deca": {"class_type": "VAEDecodeAudio",
                 "inputs": {"samples": ["sample", 0], "vae": ["vaea", 0]}},
        "video": {"class_type": "CreateVideo",
                  "inputs": {"images": ["decv", 0], "audio": ["deca", 0], "fps": 24}},
        "save": {"class_type": "SaveVideo",
                 "inputs": {"video": ["video", 0],
                            "filename_prefix": f"h3/{job.get('name', 'out')}",
                            "format": "auto", "codec": "auto"}},
    })
    return wf


def gate_jobs(jobs):
    """发车前闸门（与 Modal 版 h3_comfy.py 同源）。"""
    mode = state_load().get("mode", "sage2")
    for job in jobs:
        frames = frame_count(job.get("duration", 5.0))
        name = job.get("name", "?")
        if frames > 362:
            raise SystemExit(f"[{name}] {frames}帧 > 362（H3 训练上限 15.08s），拒绝发车")
        if mode == "sage3" and frames > 192:
            raise SystemExit(f"[{name}] {frames}帧 > 192：sage3 fp4 实测安全域 ≤8s，"
                             f"294帧显存爆表静默回退。换 sage2: server stop && server start")


def wait_prompt(prompt_id, label):
    t0 = time.time()
    last_beat = t0
    while True:
        time.sleep(2)
        hist = api(f"/history/{prompt_id}")
        if prompt_id in hist:
            entry = hist[prompt_id]
            status = entry.get("status", {})
            if status.get("completed") or status.get("status_str") == "error":
                return entry, status, time.time() - t0
        if time.time() - last_beat > 60:
            say(f"  [{label}] 跑动中 {time.time() - t0:.0f}s …")
            last_beat = time.time()


def collect_outputs(entry, prefix, exts):
    got = []
    for out in entry.get("outputs", {}).values():
        for v in out.get("images", []) + out.get("video", []):
            p = COMFY / "output" / v.get("subfolder", "") / v["filename"]
            if p.suffix in exts and p.exists():
                dest = OUT_DIR / f"{prefix}{p.name}"
                shutil.copy(p, dest)
                got.append(str(dest))
    return got


def cmd_video(args):
    if not server_up():
        raise SystemExit("服务器没起：python3 h3box.py server start")
    if args.jobs_file:
        jobs = json.loads(pathlib.Path(args.jobs_file).read_text())
    else:
        prompt = args.prompt or (pathlib.Path(args.prompt_file).read_text() if args.prompt_file else None)
        if not prompt:
            raise SystemExit("给 jobs.json 或 -p/--prompt-file")
        w, h = map(int, args.size.split("x"))
        job = {"prompt": prompt, "name": args.name, "duration": args.duration,
               "seed": args.seed, "width": w, "height": h, "quality": args.quality}
        if args.steps:
            job["steps"] = args.steps
        if args.first_frame:
            job["first_frame"] = args.first_frame
        if args.last_frame:
            job["last_frame"] = args.last_frame
        jobs = [job]
    gate_jobs(jobs)
    OUT_DIR.mkdir(exist_ok=True)
    results = []
    for i, job in enumerate(jobs):
        label = job.get("name", f"job{i}")
        say(f"[{label}] 发车 {frame_count(job.get('duration', 5.0))}帧 "
            f"seed={job.get('seed', 1101)}")
        prompt_id = api("/prompt", {"prompt": build_workflow(job)})["prompt_id"]
        entry, status, elapsed = wait_prompt(prompt_id, label)
        item = {"job": label, "seconds": round(elapsed, 1), "status": status.get("status_str")}
        if status.get("status_str") == "error":
            item["error"] = json.dumps(entry.get("status", {}), ensure_ascii=False)[:1500]
        else:
            item["files"] = collect_outputs(entry, f"{label}_", {".mp4", ".webm"})
        results.append(item)
        say(f"[{label}] {item['status']} in {elapsed:.0f}s")
    say(json.dumps(results, ensure_ascii=False, indent=1))


# ====================================================================== image
def stage_input(path, label):
    """把参考图放进 ComfyUI/input/ 并返回文件名（LoadImage 只认这个目录）。

    **永远覆盖**：同名不同内容的缓存事故 08-10 栽过一次（旧图被复用，
    看上去像模型不听话，实际是喂进去的图根本没换）。见 cmd_video 同款注释。
    """
    src = pathlib.Path(path).expanduser()
    if not src.exists():
        raise SystemExit(f"{label} 不存在: {src}")
    dest = COMFY / "input" / src.name
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(src, dest)
    return src.name


# ControlNet 预处理器节点名（comfyui_controlnet_aux 提供）。
# ⚠️ 这张表必须和盒子上 /object_info 的实际节点名对齐，改之前先核对。
PREPROC = {
    "canny":    "CannyEdgePreprocessor",
    "depth":    "DepthAnythingV2Preprocessor",
    "openpose": "DWPreprocessor",
    "lineart":  "AnyLineArtPreprocessor_aux",
    "scribble": "ScribblePreprocessor",
    "none":     None,          # 已经是处理好的控制图，直接喂
}


def parse_weighted(spec, strength_spec):
    """逗号分隔的「条目 + 权重」通用解析（--lora 和 --ref 共用）。

    强度给一个值就套用到全部；给多个就按位对应，少了拿最后一个补齐。
    滑块型 LoRA 的强度区间跟常规完全不同（2~4 甚至 ±6），所以不设范围钳制，
    由调用方负责——钳到 1.5 会把整类滑块 LoRA 废掉。
    """
    if not spec:
        return []
    names = [s.strip() for s in str(spec).split(",") if s.strip()]
    raw = [s.strip() for s in str(strength_spec or "0.8").split(",") if s.strip()]
    try:
        vals = [float(v) for v in raw] or [0.8]
    except ValueError:
        raise SystemExit(f"权重解析失败: {strength_spec!r}")
    return [(n, vals[i] if i < len(vals) else vals[-1]) for i, n in enumerate(names)]


def cmd_image(args):
    if not server_up():
        raise SystemExit("服务器没起：python3 h3box.py server start")
    pre = T2I_PRESETS[args.model]
    w, h = map(int, args.size.split("x"))
    prompt = args.prompt if args.raw else pre.get("qual_prefix", "") + args.prompt
    neg = args.neg if args.neg is not None else pre.get("neg", "")
    steps = args.steps or pre["steps"]
    cfg = args.cfg if args.cfg is not None else pre["cfg"]

    loras = parse_weighted(args.lora, args.lora_strength)

    if pre["kind"] == "ckpt":
        wf = {"ldr": {"class_type": "CheckpointLoaderSimple",
                      "inputs": {"ckpt_name": pre["ckpt"]}}}
        model, clip, vae = ["ldr", 0], ["ldr", 1], ["ldr", 2]
        # v-pred 模型必须改采样目标，否则出的是灰糊。zsnr 跟着一起开；
        # 少数 merge 款开 zsnr 会有伪影，出问题先关它（--no-zsnr）。
        if pre.get("v_pred"):
            wf["msd"] = {"class_type": "ModelSamplingDiscrete",
                         "inputs": {"model": model, "sampling": "v_prediction",
                                    "zsnr": not args.no_zsnr}}
            model = ["msd", 0]
            # 08-11 A/B/C 实测（同 seed 同提示词，像素均值）：
            #   zsnr 开 + rescale 0.7 = 45.7   ← 站主看图后选定为默认
            #   zsnr 开 + 无 rescale  = 39.4
            #   zsnr 关 + rescale 0.7 = 104.2
            # 也就是说压暗的主因是 zsnr 不是 rescale（后者只值 +6）。**均值 40 上下
            # 是这一档的正常表现，不是坏了** —— 它标准差反而更高（真黑位/高动态）。
            # 要亮画面就在提示词里写光照，别去动 zsnr。
            rs = args.rescale_cfg if args.rescale_cfg is not None else pre.get("rescale_cfg", 0.7)
            if rs > 0:
                wf["rcfg"] = {"class_type": "RescaleCFG",
                              "inputs": {"model": model, "multiplier": rs}}
                model = ["rcfg", 0]
        # Pony 强制 clip skip 2；NoobAI/Illustrious 官方明说不要设。按预设走。
        if pre.get("clip_skip"):
            wf["cskip"] = {"class_type": "CLIPSetLastLayer",
                           "inputs": {"clip": clip,
                                      "stop_at_clip_layer": pre["clip_skip"]}}
            clip = ["cskip", 0]
        # SDXL 系 LoRA 常带文本编码器权重，用双路 LoraLoader（model+clip 一起吃）。
        # 多个 LoRA 串成链，顺序即传入顺序。
        for i, (name, st) in enumerate(loras):
            k = f"ulora{i}"
            wf[k] = {"class_type": "LoraLoader",
                     "inputs": {"model": model, "clip": clip, "lora_name": name,
                                "strength_model": st, "strength_clip": st}}
            model, clip = [k, 0], [k, 1]
    else:
        wf = {
            "ldr": {"class_type": "UNETLoader",
                    "inputs": {"unet_name": pre["unet"], "weight_dtype": "default"}},
            "clip0": {"class_type": "CLIPLoader",
                      "inputs": {"clip_name": pre["te"], "type": pre["te_type"], "device": "default"}},
            "vae0": {"class_type": "VAELoader", "inputs": {"vae_name": pre["vae"]}},
        }
        model, clip, vae = ["ldr", 0], ["clip0", 0], ["vae0", 0]
        # DiT 系（krea2/anima）风格 LoRA 只动扩散权重
        for i, (name, st) in enumerate(loras):
            k = f"ulora{i}"
            wf[k] = {"class_type": "LoraLoaderModelOnly",
                     "inputs": {"model": model, "lora_name": name, "strength_model": st}}
            model = [k, 0]

    wf["pos"] = {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": clip}}
    wf["neg"] = {"class_type": "CLIPTextEncode", "inputs": {"text": neg, "clip": clip}}
    pos_out, neg_out = ["pos", 0], ["neg", 0]

    # ---- IP-Adapter：拿参考图定角色/画风（改的是 model 分支）----
    # 单张走 IPAdapterAdvanced；多张走 Encoder→CombineEmbeds→Embeds，
    # 后者的好处是**每张参考图能给独立权重**（主视图 1.0 + 侧面 0.5 这种）。
    refs = parse_weighted(args.ref, args.ref_weight)
    if len(refs) > 5:
        raise SystemExit(f"--ref 最多 5 张（IPAdapterCombineEmbeds 只有 5 个口），给了 {len(refs)}")
    if refs:
        wf["ipload"] = {"class_type": "IPAdapterUnifiedLoader",
                        "inputs": {"model": model, "preset": args.ref_preset}}
        for i, (p, _w) in enumerate(refs):
            wf[f"ipimg{i}"] = {"class_type": "LoadImage",
                               "inputs": {"image": stage_input(p, f"--ref[{i}]")}}
        if len(refs) == 1:
            # combine_embeds 是必填项，漏了 ComfyUI 直接 400（08-11 栽过）。
            # weight_type 决定搬走什么：style transfer=只要外观不要构图，
            # composition=只要构图，style and composition=都要（默认）。
            wf["ipa"] = {"class_type": "IPAdapterAdvanced",
                         "inputs": {"model": ["ipload", 0], "ipadapter": ["ipload", 1],
                                    "image": ["ipimg0", 0], "weight": refs[0][1],
                                    "weight_type": args.ref_mode,
                                    "combine_embeds": args.ref_combine,
                                    "start_at": 0.0, "end_at": 1.0,
                                    "embeds_scaling": "V only"}}
        else:
            # 循环变量别叫 w/h —— 它们是画面宽高，被遮蔽后 EmptyLatentImage 会拿到
            # 权重值当宽度（08-11 栽过，报错是 "width 0 smaller than min 16"）
            for i, (_p, rw) in enumerate(refs):
                wf[f"ipenc{i}"] = {"class_type": "IPAdapterEncoder",
                                   "inputs": {"ipadapter": ["ipload", 1],
                                              "image": [f"ipimg{i}", 0], "weight": rw}}
            # Encoder 出的是 (正, 负) 两路 EMBEDS，两路都要各自合并
            for out_idx, key in ((0, "ipcp"), (1, "ipcn")):
                ins = {"method": args.ref_combine}
                for i in range(len(refs)):
                    ins[f"embed{i + 1}"] = [f"ipenc{i}", out_idx]
                wf[key] = {"class_type": "IPAdapterCombineEmbeds", "inputs": ins}
            wf["ipa"] = {"class_type": "IPAdapterEmbeds",
                         "inputs": {"model": ["ipload", 0], "ipadapter": ["ipload", 1],
                                    "pos_embed": ["ipcp", 0], "neg_embed": ["ipcn", 0],
                                    "weight": 1.0, "weight_type": args.ref_mode,
                                    "start_at": 0.0, "end_at": 1.0,
                                    "embeds_scaling": "V only"}}
        model = ["ipa", 0]

    # ---- ControlNet：拿参考图定姿势/结构（改的是 conditioning 分支）----
    if args.control:
        wf["ctlimg"] = {"class_type": "LoadImage",
                        "inputs": {"image": stage_input(args.control, "--control")}}
        ctl_img = ["ctlimg", 0]
        pp = PREPROC.get(args.control_type)
        if args.control_type not in PREPROC:
            raise SystemExit(f"--control-type 只能是 {'/'.join(PREPROC)}")
        if pp:
            wf["ctlpre"] = {"class_type": pp,
                            "inputs": {"image": ctl_img, "resolution": max(w, h)}}
            ctl_img = ["ctlpre", 0]
        wf["ctlload"] = {"class_type": "ControlNetLoader",
                         "inputs": {"control_net_name": args.control_model}}
        wf["ctlapply"] = {"class_type": "ControlNetApplyAdvanced",
                          "inputs": {"positive": pos_out, "negative": neg_out,
                                     "control_net": ["ctlload", 0], "image": ctl_img,
                                     "strength": args.control_strength,
                                     "start_percent": 0.0, "end_percent": 1.0}}
        pos_out, neg_out = ["ctlapply", 0], ["ctlapply", 1]

    # ---- 潜变量：给了 --init 就是 img2img，否则空图 ----
    if args.init:
        wf["initimg"] = {"class_type": "LoadImage",
                         "inputs": {"image": stage_input(args.init, "--init")}}
        wf["initscale"] = {"class_type": "ImageScale",
                           "inputs": {"image": ["initimg", 0], "width": w, "height": h,
                                      "upscale_method": "lanczos", "crop": "center"}}
        # VAEEncode 只出 1 个潜变量，--batch 原本会被静默吞掉（img2img 抽不了卡）。
        # 复制成 N 份再交给 KSampler。08-11 fable 复核发现。
        wf["latenc"] = {"class_type": "VAEEncode",
                        "inputs": {"pixels": ["initscale", 0], "vae": vae}}
        if args.batch > 1:
            wf["lat"] = {"class_type": "RepeatLatentBatch",
                         "inputs": {"samples": ["latenc", 0], "amount": args.batch}}
        else:
            wf["lat"] = wf.pop("latenc")
        denoise = args.denoise if args.denoise is not None else 0.6
    else:
        wf["lat"] = {"class_type": pre["latent"],
                     "inputs": {"width": w, "height": h, "batch_size": args.batch}}
        denoise = args.denoise if args.denoise is not None else 1.0

    wf.update({
        "samp": {"class_type": "KSampler",
                 "inputs": {"model": model, "positive": pos_out, "negative": neg_out,
                            "latent_image": ["lat", 0], "seed": args.seed, "steps": steps,
                            "cfg": cfg, "sampler_name": pre["sampler"],
                            "scheduler": pre["scheduler"], "denoise": denoise}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["samp", 0], "vae": vae}},
        "save": {"class_type": "SaveImage",
                 "inputs": {"images": ["dec", 0],
                            "filename_prefix": f"t2i/{args.model}_{args.name}"}},
    })
    out_dir = pathlib.Path(args.out).expanduser() if args.out else OUT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    say(f"[{args.model}] {w}x{h} steps={steps} cfg={cfg} seed={args.seed} batch={args.batch}")
    prompt_id = api("/prompt", {"prompt": wf})["prompt_id"]
    entry, status, elapsed = wait_prompt(prompt_id, args.model)
    if status.get("status_str") == "error":
        raise SystemExit(f"ERROR: {json.dumps(entry.get('status', {}), ensure_ascii=False)[:1500]}")
    files = []
    for out in entry.get("outputs", {}).values():
        for im in out.get("images", []):
            p = COMFY / "output" / im.get("subfolder", "") / im["filename"]
            dest = out_dir / im["filename"]
            shutil.copy(p, dest)
            files.append(str(dest))
    say(f"OK {elapsed:.1f}s")
    for f in files:
        say(f"  {f}")


# ====================================================================== doctor
def model_status():
    rows = []
    for entry in MODELS:
        fname, sub = entry[1], entry[2]
        t = COMFY / "models" / sub / (entry[3] if len(entry) > 3 else pathlib.Path(fname).name)
        rows.append((t.name, t.exists(), t.stat().st_size / 1e9 if t.exists() else 0))
    return rows


def cmd_models(args):
    for name, ok, gb in model_status():
        say(f"  {'✓' if ok else '✗'} {name}" + (f"  {gb:.1f}G" if ok else "  缺失"))


def cmd_doctor(args):
    say("== GPU ==")
    subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total,memory.used",
                    "--format=csv,noheader"], check=False)
    say("== 环境 ==")
    code = ("import json, importlib\n"
            "o = {}\n"
            "import torch\n"
            "o['torch'] = torch.__version__\n"
            "o['cuda'] = torch.cuda.is_available()\n"
            "for m in ('sageattention', 'sageattn3'):\n"
            "    try:\n"
            "        importlib.import_module(m); o[m] = True\n"
            "    except Exception:\n"
            "        o[m] = False\n"
            "print(json.dumps(o))\n")
    r = subprocess.run([ENV_PY, "-c", code], capture_output=True, text=True)
    if r.returncode == 0:
        env = json.loads(r.stdout.strip().splitlines()[-1])
        say(f"  torch {env['torch']} cuda={env['cuda']} "
            f"sage2={'✓' if env['sageattention'] else '✗'} sage3={'✓' if env['sageattn3'] else '✗'}")
    else:
        say(f"  ✗ env python 起不来: {r.stderr[-500:]}")
    say("== ComfyUI ==")
    ce = COMFY / "comfy_extras"
    h3 = ce.exists() and any("MiniMaxH3ImageToVideo" in p.read_text(errors="ignore")
                             for p in ce.glob("nodes_*.py"))
    att = COMFY / "comfy/ldm/modules/attention.py"
    patched = att.exists() and "H3_SAGE3" in att.read_text()
    say(f"  H3节点={'✓' if h3 else '✗'}  sage3补丁={'✓' if patched else '✗'}")
    say("== 权重 ==")
    missing = 0
    for name, ok, gb in model_status():
        if not ok:
            missing += 1
        say(f"  {'✓' if ok else '✗'} {name}" + (f"  {gb:.1f}G" if ok else "  缺失"))
    say("== 服务器 ==")
    if server_up():
        st = state_load()
        s = api("/system_stats")
        dev = s["devices"][0]
        say(f"  UP mode={st.get('mode', '未知(state缺失)')} "
            f"显存空闲 {dev['vram_free'] / 1e9:.1f}G/{dev['vram_total'] / 1e9:.1f}G")
    else:
        say("  DOWN（python3 h3box.py server start）")
    say("== 磁盘 ==")
    du = shutil.disk_usage(COMFY if COMFY.exists() else pathlib.Path.home())
    say(f"  空闲 {du.free / 1e9:.0f}G / {du.total / 1e9:.0f}G")
    say("DOCTOR_DONE" + (f"（缺 {missing} 件权重，跑 setup --only models）" if missing else ""))


# ====================================================================== main
def main():
    ap = argparse.ArgumentParser(prog="h3box", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("setup", help="一键复活（幂等）")
    p.add_argument("--only", choices=[n for n, _ in PHASES])
    p.add_argument("--force", action="store_true")
    p.set_defaults(fn=cmd_setup)

    p = sub.add_parser("server", help="服务器管理")
    p.add_argument("action", choices=["start", "stop", "status", "log"])
    p.add_argument("--mode", choices=["sage2", "sage3", "sdpa"], default="sage2",
                   help="sage2=产线默认；sage3=fp4 仅≤8s；sdpa=裸基线")
    p.add_argument("-n", "--lines", type=int, default=60)
    p.set_defaults(fn=cmd_server)

    p = sub.add_parser("video", help="H3 视频（jobs.json 或单条）")
    p.add_argument("jobs_file", nargs="?")
    p.add_argument("-p", "--prompt")
    p.add_argument("--prompt-file")
    p.add_argument("--name", default="out")
    p.add_argument("--duration", type=float, default=5.17)
    p.add_argument("--seed", type=int, default=1101)
    p.add_argument("--size", default="1344x768")
    p.add_argument("--first-frame")
    p.add_argument("--last-frame")
    p.add_argument("--steps", type=int)
    p.add_argument("--quality", choices=["turbo", "full"], default="turbo")
    p.set_defaults(fn=cmd_video)

    p = sub.add_parser("image", help="生图（NoobAI/Anima）")
    p.add_argument("-p", "--prompt", required=True)
    p.add_argument("--model", choices=list(T2I_PRESETS), default="noobai")
    p.add_argument("--neg")
    p.add_argument("--size", default="1344x768")
    p.add_argument("--seed", type=int, default=505)
    p.add_argument("--steps", type=int)
    p.add_argument("--cfg", type=float)
    p.add_argument("--batch", type=int, default=1)
    p.add_argument("--name", default="img")
    p.add_argument("--lora", help="loras/ 下的文件名；多个用逗号分隔，按顺序串成链")
    p.add_argument("--lora-strength", default="0.8",
                   help="单值套用全部，或逗号分隔按位对应。滑块型 LoRA 常用 2~4，不钳制")
    p.add_argument("--no-zsnr", action="store_true",
                   help="v-pred 档默认开 zsnr；个别 merge 款开了有伪影，用这个关掉")
    p.add_argument("--rescale-cfg", type=float, default=None,
                   help="v-pred 的 RescaleCFG 乘数，默认 0.7；给 0 关掉（会压暗）")
    # ---- 参考图三件套（08-11）----
    p.add_argument("--init", help="img2img 底图路径（盒子本地路径）")
    p.add_argument("--denoise", type=float, default=None,
                   help="有 --init 时默认 0.6（越低越像原图）；纯文生图固定 1.0")
    p.add_argument("--control", help="ControlNet 参考图路径（定姿势/结构）")
    p.add_argument("--control-type", default="openpose",
                   help="canny/depth/openpose/lineart/scribble/none（none=图已预处理好）")
    p.add_argument("--control-strength", type=float, default=0.7)
    p.add_argument("--control-model", default="controlnet-union-sdxl-promax.safetensors",
                   help="models/controlnet/ 下的文件名")
    p.add_argument("--ref", help="IP-Adapter 参考图，逗号分隔最多 5 张（定角色/画风）")
    p.add_argument("--ref-weight", default="0.8", help="单值套用全部或逗号分隔按位对应")
    p.add_argument("--ref-combine", default="concat",
                   help="多张时的合并法: concat/add/subtract/average/norm average/max/min")
    p.add_argument("--ref-preset", default="PLUS (high strength)",
                   help="IPAdapterUnifiedLoader 的 preset；人脸一致性用 'PLUS FACE (portraits)'")
    p.add_argument("--ref-mode", default="style and composition",
                   help="style transfer / composition / style and composition / "
                        "strong style transfer / style transfer precise 等")
    p.add_argument("--raw", action="store_true", help="不加质量前缀词")
    p.add_argument("-o", "--out", help="输出目录（默认 ~/outputs）")
    p.set_defaults(fn=cmd_image)

    p = sub.add_parser("models", help="权重清单核对")
    p.set_defaults(fn=cmd_models)

    p = sub.add_parser("doctor", help="全面体检")
    p.set_defaults(fn=cmd_doctor)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
