module.exports = {
  apps : [{
    name   : "StreamApp",
    script : "server.js", // Pastikan path ini benar relatif terhadap ecosystem.config.js
    env_production: {
       NODE_ENV: "production",
       PORT: 3000, // Port yang akan digunakan aplikasi Anda
       SESSION_SECRET: "e9d1eedec7fff5464f92d10c87bbf58f875cd5dee47f9340143c9e0e103a931c",
       FFMPEG_PATH: "/usr/bin/ffmpeg" // Sesuaikan dengan path FFmpeg di VPS Anda
    },
    // Tambahkan env_development jika Anda juga ingin menjalankannya dalam mode dev di VPS
    // env_development: {
    //    NODE_ENV: "development",
    //    PORT: 3000,
    //    SESSION_SECRET: "KUNCI_RAHASIA_DEVELOPMENT_YANG_BERBEDA",
    //    FFMPEG_PATH: "/usr/bin/ffmpeg"
    // },
    watch: false, // Di produksi, biasanya watch di-disable atau diatur dengan hati-hati
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    out_file: "./logs/StreamApp-out.log",
    error_file: "./logs/StreamApp-error.log",
    merge_logs: true
  }]
};