import activeWin from 'active-win';
activeWin().then(res => console.log(JSON.stringify(res, null, 2))).catch(console.error);
