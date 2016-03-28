/**
 * Created by Elvis on 15/10/22.
 */
var ChineseName = require('chinese-name'),
	JapaneseName = require('japanese-names-generator'),
	EnglishName = require('english-names-generator'),
	pinyin = require('pinyin');

var enMailAdds = {
	'@outlook.com': 11,
	'@yahoo.com':56,
	'@gmail.com': 79,
	'@hotmail.com': 49,
	'@aol.com':6
};

var cnMailAdds = {
	'@gmail.com': 31,
	'@outlook.com': 6,
	'@hotmail.com': 8,
	'@163.com':9,
	'@qq.com':12,
	'@sina.com':3,
	'@sohu.com':1,
	'@263.com':1
};

var jpMailAdds = {
	'@gmail.com':43,
	'@hotmail.com':29,
	'@outlook.com':9,
	'@yahoo.co.jp':8,
	'@goo.ne.jp':1
};

var rand = function(l) {
	return Math.random() * l;
}

var getRandomMailAddr = function(list){
	var total_weight=0;
	for (var i in list){
		total_weight +=  list[i];

	}
	var random_num = rand(total_weight);
	var weight_sum = 0;

	for (var i in list){
		weight_sum += list[i];
		if (random_num <= weight_sum) {
			return i;
		}
	}
}

var getRandomInt = function(min,max){
	return Math.floor(Math.random()*(max+1-min)+min);
};

var getRandomJoin = function() {
	var joinStr;
	var r = Math.random();
	if (r<0.5) {
		joinStr = '.';
	} else if (r<0.7) {
		joinStr = '-';
	} else if (r<0.9) {
		joinStr = '_';
	} else {
		joinStr = ''
	}
	return joinStr;
}

var getRandomDate = function(fromDate, toDate){
	var diff = toDate.getTime()-fromDate.getTime();
	var new_diff = diff*Math.random();
	var date = new Date(fromDate.getTime()+new_diff);
	var year = date.getFullYear().toString().substr(2,2);
	var month = date.getMonth()+1;
	month = month>9? month = month.toString():'0'+month.toString();
	var day = date.getDate();
	day = day>9? day = day.toString(): '0'+day.toString();

	return Math.random()<0.33? year+month+day: year;
};

var generateChineseName = function(){
	var name = ChineseName.random();
	var py;
	switch (getRandomInt(0,1)) {
		case 0:
			py = pinyin(name,{
				style:pinyin.STYLE_NORMAL
			}).join('');
			break;
		case 1:
			py = pinyin(name,{
				style:pinyin.STYLE_FIRST_LETTER
			}).join('');
			break;
	}
	if (py.length<5){
		if (Math.random()<0.5){
			py+=getRandomDate(new Date('1965'), new Date('2006'))
		}
	} else {
		if (Math.random()<0.1){
			py+=getRandomDate(new Date('1965'), new Date('2006'))
		}
	}
	return py;
};

var generateJapaneseName = function(){
	return JapaneseName.AllName();
};

var generateEnglishName = function(){
	return EnglishName.AllName();
}

var generateMixedName = function(){
	var sur = pinyin(ChineseName.random(),{style:pinyin.STYLE_NORMAL})[0].join('');
	return EnglishName.FirstName()+getRandomJoin()+sur;
}

var generateEmailAddr = function(){
	var r = Math.random();
	if (r<0.25) {
		return generateChineseName()+getRandomMailAddr(cnMailAdds);
	} else if (r<0.9) {
		return generateEnglishName()+getRandomMailAddr(enMailAdds);
	} else if (r<0.95) {
		return generateJapaneseName()+getRandomMailAddr(jpMailAdds);
	} else if (r<0.97) {
		return generateMixedName()+getRandomMailAddr(cnMailAdds);
	} else {
		return generateMixedName()+getRandomMailAddr(enMailAdds);
	}
};

//for (var i=0;i<100;i++) {
//	console.log(generateEmailAddr());
//}

module.exports = {
	gen: function () {
		return generateEmailAddr().toLowerCase();
	}
}