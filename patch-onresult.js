const fs = require('fs');
const f = 'C:\\Users\\lenovo\\.cline\\data\\workspaces\\chat\\lgt\\client\\src\\components\\VideoCall.js';
let c = fs.readFileSync(f, 'utf8');
const lines = c.split('\n');

// Find the line index of "recognition.onresult = (event) => {"
let startIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('recognition.onresult = (event) =>')) {
    startIdx = i;
    break;
  }
}
if (startIdx === -1) {
  console.error('Could not find onresult line');
  process.exit(1);
}

// Find the closing line (the one with "    };") after startIdx
let endIdx = -1;
for (let i = startIdx + 1; i < lines.length; i++) {
  if (lines[i].includes('};')) {
    endIdx = i;
    break;
  }
}
if (endIdx === -1) {
  console.error('Could not find end of onresult block');
  process.exit(1);
}

console.log('Replacing lines', startIdx + 1, 'to', endIdx + 1);
console.log('Old content starts:', JSON.stringify(lines[startIdx].slice(0, 50)));
console.log('Old content ends:', JSON.stringify(lines[endIdx].slice(0, 50)));

const newBlock = [
  '    recognition.onresult = (event) => {',
  '      let interim = \'\';',
  '      let hasFinal = false;',
  '      for (let i = event.resultIndex; i < event.results.length; i++) {',
  '        const result = event.results[i];',
  '        const transcript = (result[0]?.transcript || \'\').trim();',
  '        if (result.isFinal) {',
  '          hasFinal = true;',
  '          if (transcript && handleFinalTranscriptRef.current) {',
  '            handleFinalTranscriptRef.current(transcript);',
  '          }',
  '        } else if (transcript) {',
  '          interim = transcript;',
  '        }',
  '      }',
  '      // Interim results: continuously translate and show as subtitles',
  '      // (no broadcast to others, just updates the local video tile)',
  '      if (!hasFinal && interim && handleInterimTranscriptRef.current) {',
  '        handleInterimTranscriptRef.current(interim);',
  '      }',
  '      if (interim) {',
  '        setTranslationStatus(`\u{1F3A4} \u{201C}...${interim.slice(-60)}\u{201D}`);',
  '      } else if (!hasFinal) {',
  '        setTranslationStatus(`\u{1F3A4} Listening...`);',
  '      }',
  '    };'
];

lines.splice(startIdx, endIdx - startIdx + 1, ...newBlock);
c = lines.join('\n');
fs.writeFileSync(f, c, 'utf8');
console.log('Done! New block at lines', startIdx + 1, 'to', startIdx + newBlock.length);

