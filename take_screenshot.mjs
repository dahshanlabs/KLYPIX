import screenshot from 'screenshot-desktop';
import path from 'path';

screenshot({ filename: 'app_screenshot.png' }).then((imgPath) => {
    console.log('Screenshot saved to:', imgPath);
}).catch((err) => {
    console.error('Screenshot failed:', err);
});
