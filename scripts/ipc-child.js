console.log('child start');
process.send?.({ msg: 'hello' });
setTimeout(() => process.exit(0), 50);
