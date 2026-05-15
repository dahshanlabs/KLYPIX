const { app } = require('electron');
console.log('App object:', app);
if (app) {
    console.log('isPackaged:', app.isPackaged);
}
app.on('ready', () => {
    console.log('App is ready');
    process.exit(0);
});
setTimeout(() => {
    console.log('Timeout reached');
    process.exit(1);
}, 5000);
