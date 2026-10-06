// รันครั้งเดียวเพื่อขอ refresh token ของบัญชี Google ที่จะใช้เก็บรูป
import 'dotenv/config';
import http from 'node:http';
import { google } from 'googleapis';

const REDIRECT = 'http://localhost:5555/oauth2callback';
const o = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, REDIRECT);
const url = o.generateAuthUrl({
  access_type: 'offline', prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/drive.file'],
});
console.log('\nเปิดลิงก์นี้ในเบราว์เซอร์ แล้วล็อกอินด้วยบัญชีที่จะใช้เก็บรูป:\n\n' + url + '\n');

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost:5555');
  if (u.pathname !== '/oauth2callback') return res.end();
  try {
    const { tokens } = await o.getToken(u.searchParams.get('code'));
    res.end('สำเร็จ ปิดหน้านี้และกลับไปที่ Terminal ได้');
    console.log('นำบรรทัดนี้ไปใส่ในไฟล์ .env:\n\nGOOGLE_REFRESH_TOKEN=' + tokens.refresh_token + '\n');
  } catch (e) {
    res.end('ผิดพลาด: ' + e.message);
    console.error(e.message);
  }
  process.exit();
}).listen(5555);
