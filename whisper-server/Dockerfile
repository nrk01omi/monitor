# GPU 対応 (CUDA 12 + cuDNN9)。CPU 専用で動かす場合は base を python:3.12-slim に変更可。
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/cache/huggingface

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        ffmpeg \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

COPY main.py .

EXPOSE 11436

# uvicorn の workers は 1 固定（faster-whisper のモデルはプロセスごとに乗るため、
# 増やすとVRAM倍増。並列化したいときは複数コンテナを別ポートで立てる）
CMD ["python3", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "11436", "--workers", "1"]
