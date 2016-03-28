/**
 * Created by jinceon on 15/6/4.
 */
var ChineseName = require('../index');
var randomNames = [];
for (var i = 0; i < 10; i++) {
    randomNames.push(ChineseName.random());
}
console.log(randomNames);
randomNames=[];
for (var i = 0; i < 10; i++) {
    randomNames.push(ChineseName.random('高'));
}
console.log(randomNames);
