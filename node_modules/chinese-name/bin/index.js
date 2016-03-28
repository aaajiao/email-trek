#!/usr/bin/env node

/**
 * Created by jinceon on 15/6/17.
 */
var program = require('commander');
var version = require('../package.json').version;
var chinesname = require('../index.js');
program
    .version(version)
    .option('-f, --familyname <n>', 'Add the specified familyname')
    .option('-t, --times <n>', 'how many random name you want, default is 1', 1);
program.parse(process.argv);

var results = [];
for(var i=0;i<program.times;i++){
    results.push(chinesname.random(program.familyname));
}
console.log(results.join(', '));