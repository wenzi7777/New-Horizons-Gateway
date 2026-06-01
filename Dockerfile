FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY newhorizons_gateway ./newhorizons_gateway

EXPOSE 13250/udp 22346/udp 5052/tcp

CMD ["python", "-m", "newhorizons_gateway.main"]
