// 'use strict'

// var links = [
// 	{title:'item1',url:'/item1'},
// 	{title:'item2',url:'/item2'},
// 	{title:'item3',url:'/item3'}
// ];

// var app = {
// 	vm: {
// 		init:function(){
// 			app.vm.name = m.prop('');
// 		}
// 	},
// 	controller: function(){
// 		// vm.init();
// 		app.vm.init();
// 	},
// 	view:function(){
// 		var name = m.prop('');
// 		return [m('div#id1.class1[title="test1"]','HELLO WORLD',
// 			m('ul.nav',
// 				links.map(function(link){
// 					return m('li',
// 						m('a[style="color:red"]',{href:link.url},link.title)
// 					);
// 				})
// 			)
// 		),
// 		m('h2#id2.class2[title="test2"]','HELLO WORLD2'),
// 		m('form.ui.form',[
// 			m('input',{placeholder:"email here",oninput:m.withAttr("value",app.vm.name),value:app.vm.name()}),
// 			// 这里可以传入很多属性，其中oninput是事件驱动->取值,value:name()是一次性(render时)设置值；
// 			//可能顺序颠倒一下更好理解；
// 			m('lable',app.vm.name())//注意当上行input的值改变时,m.render方法并不会激发redraw,所以这样不能实现angularJS的示例效果
// 		])
// 	];
// 	}
// }

// var Contact = {
//     view: function() {
//         return m("div", [
//             // menu(),
//             m("h2", "Contact")
//         ])
//     }
// }

// m.route.mode='hash';
// m.route(document.body,'/',{
// 	'/':app,
// 	'/contact':Contact
// });
// // mount可以实现view的自动redraw,基于 virtual DOM diff的redraw仅仅重绘必要的部分,性能非常高


'use strict';
var strWidth = 70;
var strHeight = 17;
//var socket = io.connect('http://t-h-e-s-p-a-c-e.com:4000');
var socket = io.connect('localhost:4000');
var staticMailList = [];
var activeMailList = '';
var curCtx = '';
var COUNT = {
	TOTAL:0,
	NOT_EXISTS:0,
	VERIFIED:0,
	SENT:0
};

function updateCount(){
	$('#total').text(COUNT.TOTAL);
	$('#not_exists').text(COUNT.NOT_EXISTS);
	$('#verified').text(COUNT.VERIFIED);
	$('#sent').text(COUNT.SENT);
}

//function updateMailAddress(mailAddress){
//	mailList.push(mailAddress);
//	if ((curCtx+mailAddress).length+1>strWidth*strHeight){
//		mailList.shift();
//		if (mailList[0].length<mailAddress.length){
//			mailList.shift();
//		}
//	}
//	curCtx = '';
//	for (var i=0; i<mailList.length; i++){
//		curCtx += mailList[i];
//		curCtx += ';';
//		if (i!=mailList-1) {
//			curCtx += ' ';
//		}
//	}
//	for (var i=0;i<curCtx.length/strWidth;i++) {
//		curCtx = curCtx.slice(0,(i+1)*(strWidth+1)-1)+"\n"+curCtx.slice((i+1)*(strWidth+1)-1);
//	}
//	console.log(curCtx);
//	$('#data>pre').text(curCtx);
//}

//function getCtx(){
//	var listCopy = mailList.slice(0);
//	var string ='';
//	for (var i=0; i<listCopy.length; i++){
//		if ((line+listCopy[i]).length+1>strWidth){
//			line += ' '.repeat(strWidth-line.length);
//			line+='\n';
//			listCopy.slice(i-1);
//			break;
//		} else {
//			line += mailList[i];
//			if (i!=mailList-1) {
//				line += ';';
//			if
//			//}
//		}
//
//	}
//	return ctx;
//}

function updateMailList(mailAddress){
	if (!mailAddress) {
		activeMailList+='';
	} else {
		var spc =(activeMailList=='')?'':' ';
		if (activeMailList.length+mailAddress.length+2<strWidth){
			var fst = mailAddress.slice(-1);
			switch (fst) {
				case '▓':
					activeMailList+=spc+mailAddress+'▓';
					break;
				case '░':
					activeMailList+=spc+mailAddress+'░';
					break;
				case '█':
					activeMailList+=spc+mailAddress+'█';
					break;
				default:
					activeMailList+=spc+mailAddress+";";
			}
			//activeMailList+=spc+mailAddress+";";
		} else {
			activeMailList +=" "+"█".repeat(strWidth-activeMailList.length-1);
			staticMailList.pop();
			staticMailList.unshift(activeMailList);
			var fst = mailAddress.slice(-1);
			switch (fst) {
				case '▓':
					activeMailList = mailAddress+'▓';
					break;
				case '░':
					activeMailList = mailAddress+'░';
					break;
				case '█':
					activeMailList = mailAddress+'█';
					break;
				default:
					activeMailList = mailAddress+";";
			}
			//activeMailList = mailAddress+";";
		}
	}
	curCtx = activeMailList+" ".repeat(strWidth-activeMailList.length)+'\n';
	for (var i=0, len=staticMailList.length; i<len; i++) {
		var linebreak = i<staticMailList.length-1? '\n':'';
		curCtx += staticMailList[i]+linebreak;
	}
	$('#data>pre').text(curCtx);
}

socket.on('prepared',function(initData){
	//console.log(initData);
	COUNT.NOT_EXISTS = initData.not_exists;
	COUNT.VERIFIED = initData.verified;
	COUNT.SENT = initData.sent;
	COUNT.TOTAL = COUNT.NOT_EXISTS+COUNT.VERIFIED+COUNT.SENT;
	updateCount();
	socket.emit('checkMail');
});

socket.on('oldData',function(lines){
	for (var i = lines.length, len=strHeight-1; i<len; i++) {
		lines.unshift("█".repeat(strWidth));
	}
	staticMailList = lines;
	updateMailList();
});




function printArray(array){
	for (var i=0, len=array.length; i<len;i++){
		console.log(array[i]);
	}
}

//socket.on('mailAddressGenerated',function(data){
//
//});

socket.on('mailChecked',function(data){
	var content = data.mailAddress;
	switch (data.checkFlag) {
		case 0:
			content = '░'.repeat(content.length);
			COUNT.NOT_EXISTS++;
			break;
		case 1:
			content = "▓".repeat(content.length);
			COUNT.VERIFIED++;
			break;
		case 2:
			content = "█".repeat(content.length);
			COUNT.SENT++;
			break;
		default:
	}
	COUNT.TOTAL++;
	updateCount();
	updateMailList(content);
	socket.emit('checkMail');
});

//socket.on('smtpError',function(data){
//	console.log(data);
//});

//socket.on('webhook',function(status){
//	switch (status) {
//		case 'success':
//			COUNT.SUCCESS++;
//			break;
//		case 'fail':
//			COUNT.FAIL++;
//			break;
//		case 'opened':
//			COUNT.OPENED++;
//			break;
//		default:
//	}
//	updateCount();
//	console.log(status);
//});

if (!String.prototype.repeat) {
	String.prototype.repeat = function(count) {
		'use strict';
		if (this == null) {
			throw new TypeError('can\'t convert ' + this + ' to object');
		}
		var str = '' + this;
		count = +count;
		if (count != count) {
			count = 0;
		}
		if (count < 0) {
			throw new RangeError('repeat count must be non-negative');
		}
		if (count == Infinity) {
			throw new RangeError('repeat count must be less than infinity');
		}
		count = Math.floor(count);
		if (str.length == 0 || count == 0) {
			return '';
		}
		// Ensuring count is a 31-bit integer allows us to heavily optimize the
		// main part. But anyway, most current (August 2014) browsers can't handle
		// strings 1 << 28 chars or longer, so:
		if (str.length * count >= 1 << 28) {
			throw new RangeError('repeat count must not overflow maximum string size');
		}
		var rpt = '';
		for (;;) {
			if ((count & 1) == 1) {
				rpt += str;
			}
			count >>>= 1;
			if (count == 0) {
				break;
			}
			str += str;
		}
		return rpt;
	}
}
// socket.emit('checkMail',function(){
// 	console.log('request to send mail');
// });

// socket.on('mailChecked',function(data){
// 	console.log(data?'success':'fail');
// });