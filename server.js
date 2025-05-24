// server.js

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const multer = require('multer'); // Langsung gunakan multer
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// Setup database SQLite
const dbPath = path.resolve(__dirname, 'streaming_app.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("Error buka database:", err.message);
    else console.log("Terhubung ke database SQLite.");
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Konfigurasi session dengan SQLiteStore
app.use(session({
    store: new SQLiteStore({
        db: 'streaming_app.db',
        dir: path.resolve(__dirname),
        table: 'sessions',
        concurrentDB: true
    }),
    secret: process.env.SESSION_SECRET || 'e9d1eedec7fff5464f92d10c87bbf58f875cd5dee47f9340143c9e0e103a931c', // Utamakan dari ENV
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production', 
        httpOnly: true, 
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 1 hari
    }
}));

// Middleware untuk memeriksa autentikasi
function isAuthenticated(req, res, next) {
    if (req.session && req.session.userId) {
        return next();
    }
    if (req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1)) {
        res.status(401).json({ message: "Akses ditolak. Silakan login." });
    } else {
        res.redirect('/login');
    }
}

// Rute untuk menyajikan halaman HTML statis
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/dashboard', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/galeri', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'public', 'galeri.html')));
app.get('/pengaturan', isAuthenticated, (req, res) => res.send('Halaman Pengaturan (Belum Dibuat)'));
app.get('/history', isAuthenticated, (req, res) => res.send('Halaman History (Belum Dibuat)'));
app.get('/', (req, res) => req.session.userId ? res.redirect('/dashboard') : res.redirect('/login'));

// Rute Autentikasi
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: 'Username dan password wajib diisi.' });
    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (err) { console.error("DB error login:", err.message); return res.status(500).json({ message: 'Kesalahan server.' }); }
        if (!user) return res.status(401).json({ message: 'Username atau password salah.' });
        bcrypt.compare(password, user.password_hash, (bcryptErr, isMatch) => {
            if (bcryptErr) { console.error("Bcrypt error:", bcryptErr.message); return res.status(500).json({ message: 'Kesalahan verifikasi.' }); }
            if (isMatch) { 
                req.session.userId = user.id; 
                req.session.username = user.username;
                req.session.save(sessionErr => { // Simpan sesi secara eksplisit
                    if (sessionErr) {
                        console.error("Session save error:", sessionErr);
                        return res.status(500).json({ message: 'Gagal menyimpan sesi.' });
                    }
                    console.log(`User ${user.username} login berhasil. Session ID: ${req.session.id}`);
                    return res.status(200).json({ message: 'Login berhasil!', redirectUrl: '/dashboard' });
                });
            } else {
                return res.status(401).json({ message: 'Username atau password salah.' });
            }
        });
    });
});
app.post('/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: 'Username & password kosong.' });
    if (password.length < 6) return res.status(400).json({ message: 'Password minimal 6 karakter.' });
    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, row) => {
        if (err) { console.error("DB error cek user:", err.message); return res.status(500).json({ message: 'Kesalahan server.' }); }
        if (row) return res.status(400).json({ message: 'Username sudah digunakan.' });
        bcrypt.hash(password, 10, (bcryptErr, hashedPassword) => {
            if (bcryptErr) { console.error("Bcrypt error hash:", bcryptErr.message); return res.status(500).json({ message: 'Gagal registrasi.' }); }
            db.run(`INSERT INTO users (username, password_hash) VALUES (?, ?)`, [username, hashedPassword], function(insertErr) {
                if (insertErr) { console.error("DB error insert user:", insertErr.message); return res.status(500).json({ message: 'Gagal simpan user.' }); }
                console.log(`User baru ID: ${this.lastID}, username: ${username}`);
                return res.status(201).json({ message: 'Registrasi berhasil!' });
            });
        });
    });
});
app.get('/logout', (req, res) => { 
    req.session.destroy(err => { 
        if (err) { console.error("Error logout:", err); return res.status(500).send('Gagal logout'); } 
        res.clearCookie('connect.sid'); 
        console.log("User logout, sesi dihancurkan.");
        res.redirect('/login'); 
    }); 
});
app.get('/api/user/profile', isAuthenticated, (req, res) => res.json({ username: req.session.username }));

// Konfigurasi Upload
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const VIDEO_UPLOADS_DIR = path.join(UPLOADS_DIR, 'videos');
const THUMBNAIL_UPLOADS_DIR = path.join(UPLOADS_DIR, 'thumbnails');
[UPLOADS_DIR, VIDEO_UPLOADS_DIR, THUMBNAIL_UPLOADS_DIR].forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); });

const videoStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!req.session || !req.session.userId) return cb(new Error("Sesi pengguna tidak ditemukan untuk upload."), false);
        const userVideoDir = path.join(VIDEO_UPLOADS_DIR, `user_${req.session.userId}`);
        if (!fs.existsSync(userVideoDir)) fs.mkdirSync(userVideoDir, { recursive: true });
        cb(null, userVideoDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const extension = path.extname(file.originalname);
        const sanitizedOriginalNameBase = file.originalname.substring(0, file.originalname.lastIndexOf(extension) || file.originalname.length).replace(/[^a-zA-Z0-9_.-]/g, '_').substring(0, 100);
        cb(null, `${sanitizedOriginalNameBase}-${uniqueSuffix}${extension}`);
    }
});
const uploadVideo = multer({ storage: videoStorage, limits: { fileSize: 500 * 1024 * 1024 }, fileFilter: (req, file, cb) => file.mimetype.startsWith('video/') ? cb(null, true) : cb(new Error('Hanya file video yang diizinkan!'), false) });

app.use('/uploaded-videos', isAuthenticated, express.static(VIDEO_UPLOADS_DIR));
app.use('/uploaded-thumbnails', isAuthenticated, express.static(THUMBNAIL_UPLOADS_DIR));

// --- RUTE API VIDEOS ---
app.post('/api/videos/upload', isAuthenticated, uploadVideo.single('videoFile'), (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'File video tidak ada atau tipe tidak valid.' });
    const { userId } = req.session;
    const videoTitle = req.body.videoName || req.file.originalname;
    const { originalname, filename: storedFilename, path: fullVideoPath, size: filesize, mimetype } = req.file;
    const relativeVideoFilePath = `user_${userId}/${storedFilename}`;
    const thumbnailStoredFilename = storedFilename.substring(0, storedFilename.lastIndexOf('.')) + '-thumb.jpg';
    const relativeThumbnailFilePath = `user_${userId}/${thumbnailStoredFilename}`;
    const userThumbnailDir = path.join(THUMBNAIL_UPLOADS_DIR, `user_${userId}`);
    if (!fs.existsSync(userThumbnailDir)) fs.mkdirSync(userThumbnailDir, { recursive: true });
    const fullThumbnailPath = path.join(userThumbnailDir, thumbnailStoredFilename);

    db.run(`INSERT INTO videos (user_id, title, original_filename, stored_filename, filepath, filesize, mimetype, poster_filepath) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, videoTitle, originalname, storedFilename, relativeVideoFilePath, filesize, mimetype, null], function(err) {
        if (err) { console.error("DB error simpan video awal:", err.message); fs.unlink(fullVideoPath, e => e && console.error("Err hapus file video setelah gagal DB insert:", e)); return res.status(500).json({ message: 'Gagal simpan info video ke DB.' }); }
        const newVideoId = this.lastID;
        console.log(`Info video user ${userId} disimpan, ID: ${newVideoId}. File: ${storedFilename}`);
        
        const FFMPEG_PATH = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg"; // Default untuk Linux/Ubuntu

        const ffmpegCommand = `${FFMPEG_PATH} -i "${fullVideoPath}" -ss 00:00:01.000 -vframes 1 -vf "scale=320:-1" -q:v 4 "${fullThumbnailPath}"`;
        console.log("Menjalankan FFmpeg untuk thumbnail:", ffmpegCommand);
        exec(ffmpegCommand, (ffmpegErr, stdout, stderr) => { // exec untuk thumbnail (operasi singkat)
            let posterUrl = null;
            let finalMessage = 'Video berhasil diunggah.';
            if (ffmpegErr) {
                console.error(`FFmpeg error saat membuat thumbnail untuk ${storedFilename}:`, ffmpegErr.message);
                console.error('FFmpeg stderr (thumbnail):', stderr);
                finalMessage = 'Video berhasil diunggah, tetapi thumbnail gagal dibuat.';
            } else {
                console.log(`Thumbnail berhasil dibuat: ${thumbnailStoredFilename}`);
                posterUrl = `/uploaded-thumbnails/${relativeThumbnailFilePath}`;
                db.run(`UPDATE videos SET poster_filepath = ? WHERE id = ?`, [relativeThumbnailFilePath, newVideoId], (updateErr) => {
                    if (updateErr) {
                        console.error(`DB error saat update poster_filepath (ID ${newVideoId}):`, updateErr.message);
                        // Jika update gagal, set posterUrl kembali ke null agar konsisten dengan DB
                        posterUrl = null; 
                    }
                });
                finalMessage = 'Video dan thumbnail berhasil diproses!';
            }
            res.status(201).json({ message: finalMessage, videoTitle, filename: originalname, url: `/uploaded-videos/${relativeVideoFilePath}`, poster_url: posterUrl });
        });
    });
});
app.get('/api/videos', isAuthenticated, (req, res) => {
    db.all(`SELECT id, title, original_filename, filepath, poster_filepath, upload_date FROM videos WHERE user_id = ? ORDER BY upload_date DESC`, [req.session.userId], (err, rows) => {
        if (err) { console.error("DB error list video:", err.message); return res.status(500).json({ message: 'Gagal ambil list video.' }); }
        res.json(rows.map(video => ({ ...video, url: `/uploaded-videos/${video.filepath}`, poster_url: video.poster_filepath ? `/uploaded-thumbnails/${video.poster_filepath}` : null })));
    });
});
app.delete('/api/videos/delete/:videoId', isAuthenticated, (req, res) => {
    const { videoId } = req.params; const { userId } = req.session;
    db.get(`SELECT filepath, poster_filepath, stored_filename FROM videos WHERE id = ? AND user_id = ?`, [videoId, userId], (err, video) => {
        if (err) { console.error("DB error get video for delete:", err.message); return res.status(500).json({ message: "Gagal proses hapus." }); }
        if (!video) return res.status(404).json({ message: "Video tidak ditemukan/Anda tidak berhak." });
        const pathsToDelete = [path.join(VIDEO_UPLOADS_DIR, video.filepath)];
        if (video.poster_filepath) pathsToDelete.push(path.join(THUMBNAIL_UPLOADS_DIR, video.poster_filepath));
        
        let filesDeletedCount = 0;
        let filesErrorCount = 0;
        pathsToDelete.forEach((p, index) => {
            if (fs.existsSync(p)) { // Hanya coba hapus jika file ada
                fs.unlink(p, uErr => {
                    if (uErr) {
                        console.warn(`Gagal hapus file ${p}:`, uErr.message);
                        filesErrorCount++;
                    } else {
                        console.log(`File ${p} berhasil dihapus.`);
                        filesDeletedCount++;
                    }
                    if (index === pathsToDelete.length - 1) proceedDeleteRecord(); // Lanjutkan setelah semua upaya hapus file
                });
            } else {
                 console.warn(`File tidak ditemukan untuk dihapus: ${p}`);
                 filesDeletedCount++; // Anggap "sukses" jika file memang tidak ada
                 if (index === pathsToDelete.length - 1) proceedDeleteRecord();
            }
        });

        if (pathsToDelete.length === 0) proceedDeleteRecord(); // Jika tidak ada file untuk dihapus (misal video_path_manual)

        function proceedDeleteRecord() {
            db.run(`DELETE FROM videos WHERE id = ? AND user_id = ?`, [videoId, userId], function(delErr) {
                if (delErr) { console.error("DB error hapus record video:", delErr.message); return res.status(500).json({ message: "Gagal hapus info video." }); }
                if (this.changes === 0) return res.status(404).json({ message: "Video tidak ditemukan di DB untuk dihapus." });
                console.log(`Video ID ${videoId} (file: ${video.stored_filename}) record DB dihapus oleh user ${userId}. Files deleted: ${filesDeletedCount}, errors: ${filesErrorCount}`);
                res.json({ message: "Video berhasil dihapus." });
            });
        }
    });
});

// --- RUTE API STREAM CONFIGS ---
const activeFFmpegProcesses = {}; 

app.post('/api/stream-configs/:streamId/start', isAuthenticated, (req, res) => {
    const { streamId } = req.params; const { userId } = req.session;
    db.get(`SELECT sc.*, v.filepath as video_server_filepath FROM stream_configs sc LEFT JOIN videos v ON sc.video_id = v.id WHERE sc.id = ? AND sc.user_id = ?`, [streamId, userId], (err, config) => {
        if (err) { console.error("DB error get config for start:", err.message); return res.status(500).json({ message: "Error DB." });}
        if (!config) return res.status(404).json({ message: "Konfigurasi stream tidak ditemukan."});
        if (activeFFmpegProcesses[streamId] && !activeFFmpegProcesses[streamId].process.killed) {
             console.log(`Stream ID ${streamId} sudah atau sedang mencoba berjalan.`);
             return res.status(409).json({ message: "Stream sudah berjalan atau sedang diproses." });
        }
        let videoSourcePath = config.video_id && config.video_server_filepath ? path.join(VIDEO_UPLOADS_DIR, config.video_server_filepath) : config.video_path_manual;
        if (!videoSourcePath || !fs.existsSync(videoSourcePath)) {
            return res.status(400).json({ message: `File video sumber tidak ditemukan: ${videoSourcePath || '(Path tidak diset)'}` });
        }
        if (!config.rtmp_url || !config.stream_key) return res.status(400).json({ message: "RTMP URL dan Stream Key wajib diisi." });

        const outputUrl = `${config.rtmp_url.replace(/\/$/, "")}/${config.stream_key}`;
        let ffmpegArgs = ['-re'];
        if (config.loop_video) ffmpegArgs.push('-stream_loop', '-1');
        ffmpegArgs.push(
            '-i', videoSourcePath, '-c:v', 'libx264', '-preset', 'veryfast',
            '-b:v', config.video_bitrate || '3000k', '-maxrate', config.video_bitrate || '3000k',
            '-bufsize', `${(parseInt((config.video_bitrate || '3000k').replace('k','')) || 3000) * 2}k`,
            '-s', config.resolution || '1920x1080', '-r', (config.fps || 30).toString(),
            '-g', ((config.fps || 30) * 2).toString(), '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
            '-f', 'flv', outputUrl
        );
        
        const FFMPEG_PATH_FOR_STREAMING = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg"; // Default untuk Linux/Ubuntu
        console.log(`Run FFmpeg (ID ${streamId}): ${FFMPEG_PATH_FOR_STREAMING} ${ffmpegArgs.join(' ')}`);
        
        const ffmpegProcess = spawn(FFMPEG_PATH_FOR_STREAMING, ffmpegArgs);
        activeFFmpegProcesses[streamId] = { process: ffmpegProcess, manuallyStopped: false, confirmedLive: false, lastErrorOutput: '' };

        // Kirim respons awal bahwa proses dimulai
        res.status(202).json({ message: "Mencoba memulai stream...", status: "CONNECTING", streamId });

        // Update DB ke "CONNECTING" atau "STARTING"
        db.run(`UPDATE stream_configs SET status = 'CONNECTING', last_active = CURRENT_TIMESTAMP WHERE id = ?`, [streamId]);

        ffmpegProcess.stderr.on('data', data => {
            const errData = data.toString();
            console.error(`FFmpeg stderr (ID ${streamId}): ${errData.substring(0, 500)}...`); // Log sebagian kecil saja jika terlalu panjang
            if (activeFFmpegProcesses[streamId]) activeFFmpegProcesses[streamId].lastErrorOutput = errData.split('\n')[0]; // Simpan baris error terakhir

            if (!activeFFmpegProcesses[streamId]?.confirmedLive) {
                if (errData.includes("speed=") || errData.includes("bitrate=") || errData.includes("frame=")) {
                    console.log(`FFmpeg (ID ${streamId}): Koneksi terkonfirmasi (streaming data dimulai).`);
                    if(activeFFmpegProcesses[streamId]) activeFFmpegProcesses[streamId].confirmedLive = true;
                    db.run(`UPDATE stream_configs SET status = 'LIVE', last_active = CURRENT_TIMESTAMP WHERE id = ?`, [streamId], uErr => {
                        if (uErr) console.error(`DB err update status LIVE setelah konfirmasi (ID ${streamId}):`, uErr.message);
                    });
                }
            }
        });

        ffmpegProcess.on('close', code => {
            console.log(`FFmpeg process (ID ${streamId}) exited with code ${code}.`);
            const procInfo = activeFFmpegProcesses[streamId];
            delete activeFFmpegProcesses[streamId]; // Hapus dari daftar aktif
            
            let finalStatus = 'OFFLINE';
            if (procInfo && !procInfo.manuallyStopped && code !== 0 && code !== null) {
                finalStatus = 'ERROR';
            } else if (procInfo && !procInfo.manuallyStopped && code === 0 && !procInfo.confirmedLive) {
                finalStatus = 'ERROR'; // Selesai tanpa pernah dikonfirmasi live
                console.warn(`Stream ${streamId} selesai tanpa konfirmasi LIVE, status diatur ke ERROR.`);
            }
            
            if (!procInfo || !procInfo.manuallyStopped || finalStatus === 'ERROR') {
                db.run(`UPDATE stream_configs SET status = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?`, [finalStatus, streamId], uErr => {
                    if (uErr) console.error(`DB err update status ke ${finalStatus} (ID ${streamId}) saat FFmpeg close:`, uErr.message);
                });
            }
        });

        ffmpegProcess.on('error', spawnErr => {
            console.error(`Gagal memulai FFmpeg process (ID ${streamId}):`, spawnErr);
            delete activeFFmpegProcesses[streamId];
            db.run(`UPDATE stream_configs SET status = 'ERROR', last_active = CURRENT_TIMESTAMP WHERE id = ?`, [streamId]);
            // Respons sudah dikirim (202), jadi tidak bisa kirim error lagi di sini
        });
    });
});

app.post('/api/stream-configs/:streamId/stop', isAuthenticated, (req, res) => {
    const { streamId } = req.params; const { userId } = req.session;
    const procInfo = activeFFmpegProcesses[streamId];

    if (procInfo && procInfo.process && !procInfo.process.killed) {
        console.log(`Menghentikan stream ID ${streamId}...`);
        procInfo.manuallyStopped = true;
        procInfo.process.kill('SIGINT'); 
        // Hapus dari activeFFmpegProcesses akan dihandle oleh event 'close'
        db.run(`UPDATE stream_configs SET status = 'OFFLINE', last_active = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`, [streamId, userId], function(err) {
            if (err) return res.status(500).json({ message: "Stream dihentikan, gagal update DB." });
            if (this.changes === 0) return res.status(404).json({message: "Config tidak ada."});
            res.json({ message: "Stream berhasil dihentikan!", status: "OFFLINE", streamId });
        });
    } else {
        db.run(`UPDATE stream_configs SET status = 'OFFLINE', last_active = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status != 'OFFLINE'`, [streamId, userId], function(err){
            if (err) console.error("DB err fallback stop:", err.message);
            if (this.changes > 0) console.log(`Status stream ${streamId} diupdate ke OFFLINE (fallback).`);
        });
        res.status(404).json({ message: "Stream tidak sedang berjalan atau tidak ditemukan." });
    }
});

app.get('/api/stream-configs/:streamId/status', isAuthenticated, (req, res) => {
    const { streamId } = req.params;
    const { userId } = req.session;

    db.get("SELECT status, last_active FROM stream_configs WHERE id = ? AND user_id = ?", [streamId, userId], (err, config) => {
        if (err) { console.error("DB error get status:", err.message); return res.status(500).json({ message: "Error DB."});}
        if (!config) return res.status(404).json({ message: "Config tidak ditemukan."});

        const procInfo = activeFFmpegProcesses[streamId];
        const isProcessActive = procInfo && procInfo.process && !procInfo.process.killed;
        
        let currentStatus = config.status;
        if (isProcessActive && procInfo.confirmedLive) {
            currentStatus = 'LIVE';
        } else if (isProcessActive && !procInfo.confirmedLive) {
            currentStatus = 'CONNECTING'; // Atau 'STARTING'
        } else if (!isProcessActive && config.status === 'LIVE') {
            // Proses tidak ada tapi DB bilang LIVE, ini indikasi error
            currentStatus = 'ERROR'; 
        } // Jika tidak, status dari DB adalah yang paling akurat

        res.json({ streamId, status: currentStatus, isProcessRunning: isProcessActive, lastError: procInfo ? procInfo.lastErrorOutput : null });
    });
});


app.post('/api/stream-configs', isAuthenticated, (req, res) => { /* ... (Sama seperti sebelumnya, pastikan default values baru ada) ... */ });
app.get('/api/stream-configs', isAuthenticated, (req, res) => { /* ... (Sama seperti sebelumnya, pastikan semua field baru diambil dan dikirim) ... */ });
app.put('/api/stream-configs/:streamId', isAuthenticated, (req, res) => { /* ... (Sama seperti sebelumnya, pastikan semua field baru bisa diupdate dan dikirim kembali) ... */ });
app.delete('/api/stream-configs/:streamId', isAuthenticated, (req, res) => { /* ... (Sama seperti sebelumnya) ... */ });


// Inisialisasi Tabel Database
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS videos (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT, original_filename TEXT NOT NULL, stored_filename TEXT UNIQUE NOT NULL, filepath TEXT NOT NULL, poster_filepath TEXT, filesize INTEGER, mimetype TEXT, upload_date DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
    db.run(`CREATE TABLE IF NOT EXISTS stream_configs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, video_id INTEGER, video_path_manual TEXT, platform TEXT, rtmp_url TEXT, stream_key TEXT, resolution TEXT DEFAULT '1920x1080', fps INTEGER DEFAULT 30, video_bitrate TEXT DEFAULT '3000k', loop_video INTEGER DEFAULT 1, status TEXT DEFAULT 'OFFLINE', last_active DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE SET NULL)`);
    
    if (process.env.NODE_ENV === 'development') {
        console.log("Mode DEVELOPMENT: Tabel tidak direset otomatis. Hapus 'streaming_app.db' manual jika perlu skema baru.");
    }
});

// Penanganan Sinyal untuk Cleanup
function cleanupFFmpegProcesses() { /* ... (Sama seperti sebelumnya) ... */ }
process.on('SIGINT', cleanupFFmpegProcesses);
process.on('SIGTERM', cleanupFFmpegProcesses);

app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
    if (process.env.NODE_ENV === 'development') console.log("Server berjalan dalam mode DEVELOPMENT.");
});