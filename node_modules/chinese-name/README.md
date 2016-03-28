# ChineseName
random chinese name generator

##API
**random([familyName])**

##use in nodejs
1. install  
`npm install chinese-name`
2. use  
```js
var ChineseName = require('chinese-name');
console.log(ChineseName.random());
```

##use in browser
1. include `index.js`,eg.  
`<script src="path_to/index.js"></script>`
2. use  
```js
var name = ChineseName.random();
alert(name);
```
