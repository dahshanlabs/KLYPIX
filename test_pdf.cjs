const fs = require('fs');

async function testPdf() {
    try {
        const pdfParseModule = await import('pdf-parse');
        const pdfParse = pdfParseModule.default || pdfParseModule;

        const dataBuffer = fs.readFileSync('C:/Users/HP/Desktop/FE-Electrical-and-Computer-CBT-specs.pdf');

        console.log('Got pdfParse:', typeof pdfParse);

        const data = await pdfParse(dataBuffer);
        console.log('Successfully read PDF!');
        console.log('Pages:', data.numpages);
        console.log('Sample text:', data.text.substring(0, 500));
    } catch (err) {
        console.error('Failed to parse PDF:', err);
    }
}

testPdf();
