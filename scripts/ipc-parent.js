const { fork } = require('node:child_process');
const path = require('node:path');
const childPath = path.join(__dirname, 'ipc-child.js');
const child = fork(childPath, [], { stdio: ['pipe','pipe','pipe','ipc'] });
child.on('message', (msg) => {
  console.log('parent message', msg);
});
child.stdout.on('data', chunk => process.stdout.write('child stdout: '+chunk.toString()));
child.stderr.on('data', chunk => process.stderr.write('child stderr: '+chunk.toString()));
child.on('exit', (code, signal) => {
  console.log('child exit', code, signal);
});
