// server.js

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process'); // exec untuk thumbnail, spawn untuk streaming

const app = express();
const PORT = process.env.PORT || 3000;

const dbPath = path.resolve(__dirname, 'streaming_app.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("Error buka database:", err.message);
    else console.log("Terhubung ke database SQLite.");
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    store: new SQLiteStore({
        db: 'streaming_app.db', // Nama file database Anda
        dir: path.resolve(__dirname),      // Direktori tempat file .db Anda berada
        table: 'sessions',          // Nama tabel untuk sesi (akan dibuat otomatis)
        concurrentDB: true          // Tambahkan ini jika ada potensi akses DB bersamaan
    }),
    secret: 'MZx7q9J2sP5DkF8RcH1eVbN0yL4gA6hWnGtZu3XfCjIoEoSvYpUaK8wT7mKlD3rB', // GANTI DENGAN KUNCI RAHASIA KUAT ANDA SENDIRI
    resave: false, // jangan simpan kembali sesi jika tidak ada perubahan
    saveUninitialized: false, // jangan buat sesi sampai ada sesuatu yang disimpan
    cookie: { 
        secure: process.env.NODE_ENV === 'production', // true jika HTTPS
        httpOnly: true, // Untuk keamanan, cegah akses cookie via JavaScript sisi klien
        sameSite: 'lax', // Perlindungan CSRF dasar
        maxAge: 24 * 60 * 60 * 1000 // Durasi cookie sesi (misalnya 1 hari)
    }
}));


function isAuthenticated(req, res, next) {
    if (req.session && req.session.userId) return next();
    if (req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1)) {
        res.status(401).json({ message: "Akses ditolak. Silakan login." });
    } else {
        res.redirect('/login');
    }
}

// Rute Statis
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
            if (isMatch) { req.session.userId = user.id; req.session.username = user.username; return res.status(200).json({ message: 'Login berhasil!', redirectUrl: '/dashboard' });}
            else return res.status(401).json({ message: 'Username atau password salah.' });
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
                return res.status(201).json({ message: 'Registrasi berhasil!' });
            });
        });
    });
});
app.get('/logout', (req, res) => { req.session.destroy(err => { if (err) { console.error("Error logout:", err); return res.status(500).send('Gagal logout'); } res.clearCookie('connect.sid'); res.redirect('/login'); }); });
app.get('/api/user/profile', isAuthenticated, (req, res) => res.json({ username: req.session.username }));

// Konfigurasi Upload
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const VIDEO_UPLOADS_DIR = path.join(UPLOADS_DIR, 'videos');
const THUMBNAIL_UPLOADS_DIR = path.join(UPLOADS_DIR, 'thumbnails');
[UPLOADS_DIR, VIDEO_UPLOADS_DIR, THUMBNAIL_UPLOADS_DIR].forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); });

const videoStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!req.session.userId) return cb(new Error("Sesi pengguna tidak ditemukan untuk upload."), false);
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

// Rute Penyajian File Statis
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
        if (err) { console.error("DB error simpan video:", err.message); fs.unlink(fullVideoPath, e => e && console.error("Err hapus file setelah gagal DB insert:", e)); return res.status(500).json({ message: 'Gagal simpan info video ke DB.' }); }
        const newVideoId = this.lastID;
        
        // ---- GANTI FFMPEG_PATH INI ----
        const FFMPEG_PATH_FOR_THUMBNAIL = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg"; // Atau path absolut lain
        // ------------------------------

        const ffmpegCommand = `${FFMPEG_PATH_FOR_THUMBNAIL} -i "${fullVideoPath}" -ss 00:00:01.000 -vframes 1 -vf "scale=320:-1" -q:v 4 "${fullThumbnailPath}"`;
        exec(ffmpegCommand, (ffmpegErr, stdout, stderr) => {
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
                    if (updateErr) console.error(`DB error saat update poster_filepath (ID ${newVideoId}):`, updateErr.message);
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
    db.get(`SELECT filepath, poster_filepath FROM videos WHERE id = ? AND user_id = ?`, [videoId, userId], (err, video) => {
        if (err) { console.error("DB error get video for delete:", err.message); return res.status(500).json({ message: "Gagal proses hapus." }); }
        if (!video) return res.status(404).json({ message: "Video tidak ditemukan/Anda tidak berhak." });
        const pathsToDelete = [path.join(VIDEO_UPLOADS_DIR, video.filepath)];
        if (video.poster_filepath) pathsToDelete.push(path.join(THUMBNAIL_UPLOADS_DIR, video.poster_filepath));
        pathsToDelete.forEach(p => fs.unlink(p, uErr => uErr && uErr.code !== 'ENOENT' && console.warn(`Gagal hapus file ${p}:`, uErr.message)));
        db.run(`DELETE FROM videos WHERE id = ? AND user_id = ?`, [videoId, userId], function(delErr) {
            if (delErr) { console.error("DB error hapus record video:", delErr.message); return res.status(500).json({ message: "Gagal hapus info video." }); }
            if (this.changes === 0) return res.status(404).json({ message: "Video tidak ditemukan di DB untuk dihapus." });
            res.json({ message: "Video berhasil dihapus." });
        });
    });
});

// --- RUTE API STREAM CONFIGS ---
const activeFFmpegProcesses = {}; // Simpan proses FFmpeg yang aktif: { streamId: ffmpegProcess }

app.post('/api/stream-configs/:streamId/start', isAuthenticated, (req, res) => {
    const { streamId } = req.params; const { userId } = req.session;
    db.get(`SELECT sc.*, v.filepath as video_server_filepath FROM stream_configs sc LEFT JOIN videos v ON sc.video_id = v.id WHERE sc.id = ? AND sc.user_id = ?`, [streamId, userId], (err, config) => {
        if (err) { console.error("DB error get config for start:", err.message); return res.status(500).json({ message: "Error DB." });}
        if (!config) return res.status(404).json({ message: "Konfigurasi stream tidak ditemukan."});
        if (activeFFmpegProcesses[streamId] && !activeFFmpegProcesses[streamId].killed) { // Cek juga apakah sudah di-kill
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
            '-bufsize', `${(parseInt(config.video_bitrate.replace('k','')) || 3000) * 2}k`, // Pastikan parseInt benar
            '-s', config.resolution || '1920x1080', '-r', (config.fps || 30).toString(),
            '-g', ((config.fps || 30) * 2).toString(), '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
            '-f', 'flv', outputUrl
        );
        
        // ---- GANTI FFMPEG_PATH INI ----
        const FFMPEG_PATH_FOR_STREAMING = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg"; // Atau path absolut lain
        // ------------------------------

        console.log(`Run FFmpeg (ID ${streamId}): ${FFMPEG_PATH_FOR_STREAMING} ${ffmpegArgs.join(' ')}`);
        const ffmpegProcess = spawn(FFMPEG_PATH_FOR_STREAMING, ffmpegArgs);
        activeFFmpegProcesses[streamId] = { process: ffmpegProcess, manuallyStopped: false };


        let ffmpegErrOutput = ''; // Kumpulkan output error dari FFmpeg
        ffmpegProcess.stderr.on('data', data => {
            const errData = data.toString();
            console.error(`FFmpeg stderr (ID ${streamId}): ${errData}`);
            ffmpegErrOutput += errData;
        });

        ffmpegProcess.on('close', code => {
            console.log(`FFmpeg process (ID ${streamId}) exited with code ${code}. Manually stopped: ${activeFFmpegProcesses[streamId]?.manuallyStopped}`);
            const procInfo = activeFFmpegProcesses[streamId];
            const manuallyStopped = procInfo ? procInfo.manuallyStopped : false;
            
            delete activeFFmpegProcesses[streamId];
            
            let finalStatus = 'OFFLINE';
            if (!manuallyStopped && code !== 0 && code !== null) { // code null jika di-kill manual tanpa sinyal spesifik
                finalStatus = 'ERROR';
            }
            
            // Hanya update status jika tidak dihentikan secara manual (karena /stop sudah handle)
            // atau jika statusnya memang ERROR karena crash.
            if (!manuallyStopped || finalStatus === 'ERROR') {
                db.run(`UPDATE stream_configs SET status = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?`, [finalStatus, streamId], uErr => {
                    if (uErr) console.error(`DB error update status ke ${finalStatus} (ID ${streamId}) saat FFmpeg close:`, uErr.message);
                    else console.log(`Status stream ID ${streamId} di DB diupdate ke ${finalStatus} karena FFmpeg berhenti.`);
                });
            }
        });
        ffmpegProcess.on('error', spawnErr => {
            console.error(`Gagal memulai FFmpeg process (ID ${streamId}):`, spawnErr);
            delete activeFFmpegProcesses[streamId];
            // Respons error sudah terkirim dari blok db.run di bawah jika update ke LIVE gagal
        });

        // Optimistic update ke LIVE, jika gagal spawn, akan dihandle
        db.run(`UPDATE stream_configs SET status = 'LIVE', last_active = CURRENT_TIMESTAMP WHERE id = ?`, [streamId], updateErr => {
            if (updateErr) {
                console.error(`DB err update status LIVE (ID ${streamId}):`, updateErr.message);
                if (ffmpegProcess && !ffmpegProcess.killed) ffmpegProcess.kill('SIGINT'); // Hentikan jika sudah terlanjur spawn
                delete activeFFmpegProcesses[streamId];
                return res.status(500).json({ message: "Gagal memulai stream (DB update error)." });
            }
            // Periksa jika FFmpeg langsung exit dengan error sebelum respons dikirim
            if (ffmpegProcess.exitCode !== null && ffmpegProcess.exitCode !== 0) {
                 console.error(`FFmpeg (ID ${streamId}) langsung exit dengan code ${ffmpegProcess.exitCode} setelah spawn.`);
                 db.run(`UPDATE stream_configs SET status = 'ERROR', last_active = CURRENT_TIMESTAMP WHERE id = ?`, [streamId]);
                 delete activeFFmpegProcesses[streamId];
                 return res.status(500).json({ message: `Gagal memulai FFmpeg. Output: ${ffmpegErrOutput || 'Tidak ada output error spesifik.'}` });
            }
            console.log(`Stream ID ${streamId} dimulai. Status di DB diupdate ke LIVE.`);
            res.json({ message: "Stream berhasil dimulai!", status: "LIVE", streamId });
        });
    });
});

app.post('/api/stream-configs/:streamId/stop', isAuthenticated, (req, res) => {
    const { streamId } = req.params; const { userId } = req.session;
    const procInfo = activeFFmpegProcesses[streamId];

    if (procInfo && procInfo.process && !procInfo.process.killed) {
        console.log(`Menghentikan stream ID ${streamId}...`);
        procInfo.manuallyStopped = true; // Tandai bahwa ini dihentikan manual
        procInfo.process.kill('SIGINT'); // Kirim sinyal stop yang lebih halus
        
        // Hapus dari activeFFmpegProcesses akan dihandle oleh event 'close'
        // tapi bisa juga langsung di sini jika ingin lebih cepat merefleksikan
        // delete activeFFmpegProcesses[streamId]; 

        db.run(`UPDATE stream_configs SET status = 'OFFLINE', last_active = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`, [streamId, userId], function(err) {
            if (err) { console.error(`DB error update status ke OFFLINE (stop) untuk stream ID ${streamId}:`, err.message); return res.status(500).json({ message: "Stream dihentikan, tapi gagal update status DB." }); }
            if (this.changes === 0) return res.status(404).json({message: "Konfigurasi stream tidak ditemukan untuk diupdate."});
            res.json({ message: "Stream berhasil dihentikan!", status: "OFFLINE", streamId });
        });
    } else {
        // Jika proses tidak aktif, pastikan status di DB adalah OFFLINE
        db.run(`UPDATE stream_configs SET status = 'OFFLINE', last_active = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status != 'OFFLINE'`, [streamId, userId], function(err){
            if (err) console.error("DB error fallback stop stream:", err.message);
            if (this.changes > 0) console.log(`Status stream ID ${streamId} diupdate ke OFFLINE (fallback stop).`);
        });
        res.status(404).json({ message: "Stream tidak sedang berjalan atau tidak ditemukan untuk dihentikan." });
    }
});

app.post('/api/stream-configs', isAuthenticated, (req, res) => {
    const { userId } = req.session;
    const { name, loop_video = true, resolution = "1920x1080", fps = 30, video_bitrate = "3000k", video_id = null, video_path_manual = null, platform = null, rtmp_url = "rtmp://a.rtmp.youtube.com/live2", stream_key = null } = req.body;
    const configName = name || `Stream Baru ${new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit'})}`; // Format waktu lebih singkat
    db.run(`INSERT INTO stream_configs (user_id, name, video_id, video_path_manual, platform, rtmp_url, stream_key, loop_video, resolution, fps, video_bitrate, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OFFLINE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [userId, configName, video_id, video_path_manual, platform, rtmp_url, stream_key, loop_video, resolution, fps, video_bitrate], function(err) {
        if (err) { console.error("DB error buat config:", err.message); return res.status(500).json({ message: "Gagal buat config." }); }
        const newId = this.lastID;
        db.get(`SELECT sc.*, v.filepath as video_server_filepath, v.title as video_title_from_videos, v.poster_filepath FROM stream_configs sc LEFT JOIN videos v ON sc.video_id = v.id WHERE sc.id = ? AND sc.user_id = ?`, [newId, userId], (getErr, newConf) => {
            if (getErr || !newConf) { console.error("DB error get new config:", getErr); return res.status(500).json({ message: "Config dibuat, gagal ambil detail." });}
            let vp = null, pp = null; if (newConf.video_id && newConf.video_server_filepath) { vp = `/uploaded-videos/${newConf.video_server_filepath}`; if (newConf.poster_filepath) pp = `/uploaded-thumbnails/${newConf.poster_filepath}`; } else if (newConf.video_path_manual) vp = newConf.video_path_manual;
            const respData = { ...newConf, video_path_public: vp, poster_url: pp, video_title: newConf.video_title_from_videos };
            ['video_server_filepath', 'video_title_from_videos', 'poster_filepath'].forEach(k => delete respData[k]);
            res.status(201).json(respData);
        });
    });
});
app.get('/api/stream-configs', isAuthenticated, (req, res) => {
    db.all(`SELECT sc.*, v.filepath as video_server_filepath, v.title as video_title_from_videos, v.poster_filepath FROM stream_configs sc LEFT JOIN videos v ON sc.video_id = v.id WHERE sc.user_id = ? ORDER BY sc.created_at DESC`, [req.session.userId], (err, rows) => {
        if (err) { console.error("DB error ambil configs:", err.message); return res.status(500).json({ message: "Gagal ambil configs." }); }
        res.json(rows.map(c => {
            let vp = null, pp = null; if (c.video_id && c.video_server_filepath) { vp = `/uploaded-videos/${c.video_server_filepath}`; if (c.poster_filepath) pp = `/uploaded-thumbnails/${c.poster_filepath}`; } else if (c.video_path_manual) vp = c.video_path_manual;
            const rd = { ...c, video_path_public: vp, poster_url: pp, video_title: c.video_title_from_videos };
            ['video_server_filepath', 'video_title_from_videos', 'poster_filepath'].forEach(k => delete rd[k]); return rd;
        }));
    });
});
app.put('/api/stream-configs/:streamId', isAuthenticated, (req, res) => {
    const { streamId } = req.params; const { userId } = req.session;
    const { name, rtmp_url, stream_key, video_id, video_path_manual, loop_video, resolution, fps, video_bitrate, platform, status } = req.body; // Terima status dari frontend
    if (!name) return res.status(400).json({ message: "Nama stream wajib." });

    // Jika status yang dikirim adalah LIVE, dan stream tidak aktif di backend, jangan update ke LIVE.
    // Ini mencegah UI secara manual mengubah ke LIVE jika stream sebenarnya tidak jalan.
    // Namun, jika stream sedang LIVE dan user mengedit field lain, status LIVE harus dipertahankan.
    let statusToSave = status;
    const currentActiveProcess = activeFFmpegProcesses[streamId];
    if (status === 'LIVE' && (!currentActiveProcess || currentActiveProcess.process.killed)) {
        // Frontend mencoba set LIVE, tapi backend tidak ada proses aktif, jangan set LIVE.
        // Ambil status dari DB atau set ke OFFLINE.
        // Untuk sementara, kita bisa abaikan perubahan status ke LIVE jika proses tidak ada.
        // Atau, lebih baik, backend yang mengontrol status LIVE sepenuhnya.
        // Biarkan frontend mengirim apa adanya, backend yang validasi.
        // Jika frontend kirim status, dan itu LIVE, tapi tidak ada proses -> set ke OFFLINE/ERROR
    }


    db.run(`UPDATE stream_configs SET name = ?, rtmp_url = ?, stream_key = ?, video_id = ?, video_path_manual = ?, loop_video = ?, resolution = ?, fps = ?, video_bitrate = ?, platform = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`,
        [name, rtmp_url, stream_key, video_id, video_path_manual, loop_video, resolution, fps, video_bitrate, platform, statusToSave /* status yg akan disimpan */, streamId, userId], function(err) {
        if (err) { console.error("DB error update config:", err.message); return res.status(500).json({ message: "Gagal update config." }); }
        if (this.changes === 0) return res.status(404).json({ message: "Config tidak ada/Anda tidak berhak." });
        db.get(`SELECT sc.*, v.filepath as video_server_filepath, v.title as video_title_from_videos, v.poster_filepath FROM stream_configs sc LEFT JOIN videos v ON sc.video_id = v.id WHERE sc.id = ? AND sc.user_id = ?`, [streamId, userId], (getErr, uRow) => {
            if (getErr || !uRow) { console.error("DB error get updated config:", getErr); return res.status(200).json({ message: "Update berhasil (gagal ambil data terbaru).", id: streamId, name });}
            let vp = null, pp = null; if (uRow.video_id && uRow.video_server_filepath) { vp = `/uploaded-videos/${uRow.video_server_filepath}`; if (uRow.poster_filepath) pp = `/uploaded-thumbnails/${uRow.poster_filepath}`; } else if (uRow.video_path_manual) vp = uRow.video_path_manual;
            const rd = { ...uRow, video_path_public: vp, poster_url: pp, video_title: uRow.video_title_from_videos };
            ['video_server_filepath', 'video_title_from_videos', 'poster_filepath'].forEach(k => delete rd[k]);
            res.json(rd);
        });
    });
});
app.delete('/api/stream-configs/:streamId', isAuthenticated, (req, res) => {
    const { streamId } = req.params; const { userId } = req.session;
    const procInfo = activeFFmpegProcesses[streamId];
    if (procInfo && procInfo.process && !procInfo.process.killed) {
        console.log(`Menghentikan stream ID ${streamId} sebelum menghapus konfigurasi.`);
        procInfo.manuallyStopped = true; // Tandai ini
        procInfo.process.kill('SIGINT'); 
    }
    db.run(`DELETE FROM stream_configs WHERE id = ? AND user_id = ?`, [streamId, userId], function(err) {
        if (err) { console.error("DB error hapus config:", err.message); return res.status(500).json({ message: "Gagal hapus config." }); }
        if (this.changes === 0) return res.status(404).json({ message: "Config tidak ada/Anda tidak berhak." });
        delete activeFFmpegProcesses[streamId]; // Pastikan dihapus dari memori juga
        res.json({ message: "Konfigurasi stream dihapus." });
    });
});

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
function cleanupFFmpegProcesses() {
    console.log('Menerima sinyal keluar, membersihkan proses FFmpeg yang aktif...');
    for (const streamId in activeFFmpegProcesses) {
        const procInfo = activeFFmpegProcesses[streamId];
        if (procInfo && procInfo.process && !procInfo.process.killed) {
            console.log(`Menghentikan FFmpeg untuk stream ID: ${streamId} saat server shutdown.`);
            procInfo.manuallyStopped = true; // Anggap ini penghentian manual dari sisi server
            procInfo.process.kill('SIGINT'); // Coba hentikan dengan baik
        }
    }
    // Beri sedikit waktu untuk FFmpeg berhenti sebelum exit
    setTimeout(() => {
        console.log("Proses cleanup selesai.");
        process.exit(0);
    }, 2000); // Tunggu 2 detik
}

process.on('SIGINT', cleanupFFmpegProcesses);
process.on('SIGTERM', cleanupFFmpegProcesses);


app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
    if (process.env.NODE_ENV === 'development') console.log("Server berjalan dalam mode DEVELOPMENT.");
});