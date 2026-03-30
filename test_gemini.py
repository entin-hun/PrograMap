import os
import requests
from dotenv import load_dotenv

load_dotenv("backend/.env")
key = os.getenv("GOOGLE_API_KEY")

prompt = "Hello"
url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={key}"

res = requests.post(url, json={
    "contents": [{"parts": [{"text": prompt}]}]
})

print("Status:", res.status_code)
print("Body:", res.text)
