FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code (build context = project root)
COPY backend/main.py backend/db.py backend/wix_client.py backend/salonic_client.py ./
COPY species_profiles.json .

EXPOSE 8223

CMD ["python", "main.py"]
