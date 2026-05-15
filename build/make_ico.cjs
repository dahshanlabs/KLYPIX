const pngToIco = require('png-to-ico').default || require('png-to-ico');
const fs = require('fs');

pngToIco('build/icon.png')
    .then(buf => {
        fs.writeFileSync('build/icon.ico', buf);
        console.log('ICO created successfully:', buf.length, 'bytes');
    })
    .catch(err => {
        console.error('ICO conversion failed:', err.message);
        console.log('Falling back to raw copy...');
        fs.copyFileSync('build/icon.png', 'build/icon.ico');
        process.exit(0);
    });
