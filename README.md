# PhotoShare

เว็บแอพอัลบั้มรูปแบบสาธารณะ: ใครก็อัปโหลดและสร้างอัลบั้มได้โดยไม่ต้อง login
รูปทั้งหมดเก็บใน Google Drive ของเจ้าของเว็บบัญชีเดียว

โครงสร้างใน Drive:  PhotoShare/ ├─ <ชื่ออัลบั้ม>/ (รูปต้นฉบับ)  └─ _thumbs/ (thumbnail 400px)

## ตั้งค่า Google Cloud (ครั้งเดียว)
1. ใช้โปรเจกต์เดิมได้ (เปิด Drive API ไว้แล้ว) > Credentials > Create OAuth client ID > **Web application**
   - Authorized redirect URIs: `http://localhost:5555/oauth2callback`
2. OAuth consent screen > กด **Publish app** (สถานะ In production)
   **สำคัญ:** ถ้าค้างที่ Testing refresh token จะหมดอายุทุก 7 วันและเว็บจะใช้ไม่ได้
   (scope `drive.file` ไม่ต้องส่งตรวจสอบกับ Google)

## รัน
```bash
npm install
cp .env.example .env     # ใส่ GOOGLE_CLIENT_ID และ GOOGLE_CLIENT_SECRET
npm run auth             # เปิดลิงก์ ล็อกอินด้วยบัญชี Drive ที่จะเก็บรูป แล้วคัดลอก GOOGLE_REFRESH_TOKEN ใส่ .env
npm start                # เปิด http://localhost:3000
```

## สิทธิ์การลบ (DELETE_MODE ใน .env)
- `owner` (ค่าเริ่มต้น): ลบอัลบั้มได้เฉพาะผู้สร้าง, ลบรูปได้เฉพาะผู้อัปโหลดหรือเจ้าของอัลบั้ม
  ระบบจำผู้ใช้ด้วยรหัสสุ่มในเบราว์เซอร์ (ไม่ต้องสมัคร) ล้างข้อมูลเบราว์เซอร์/เปลี่ยนเครื่อง = เสียสิทธิ์ลบ
- `public`: ใครก็ลบได้ทุกอย่าง
- `ADMIN_PASSWORD`: ตั้งแล้วเปิด Console ในเบราว์เซอร์พิมพ์ `localStorage.admin='รหัส'` จะลบได้ทุกอย่าง
- ของที่ลบจะไปอยู่ในถังขยะ Drive (กู้คืนได้ 30 วัน และยังนับโควตาจนกว่าจะล้างถัง)

## Deploy
ต้องใช้ host ที่รัน Node 18+ ได้ เช่น Render, Railway, Fly.io หรือ VPS
ตั้งค่า environment variables ตาม .env.example (ไม่ต้องอัปโหลดไฟล์ .env)
โฟลเดอร์ cache เป็นแค่แคช ลบทิ้งได้ ระบบสร้างใหม่เอง
