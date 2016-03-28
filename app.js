var express = require('express'),
	path = require('path'),
	app = express(),
	svg = express(),
	bodyparser = require('body-parser'),
	server = require('http').Server(app),
	io = require('socket.io')(server);

var nodemailer = require('nodemailer'),
	smtpConfig = {
	host: '***********.com',
	port: *****,
	secure: true, // use SSL
	auth: {
		user: '**********',
		pass: '**********'
	},
	tls: {rejectUnauthorized: false}
};
	transporter = nodemailer.createTransport(smtpConfig);

var getIP = require('external-ip')(),
	moment = require('moment'),
	DB = require('./lib/db');
require('moment-range');

var mailContent = require('./lib/mail-content'),
	AddrGenerator = require('./lib/mail-address-generator');

var MAIL_STATUS = {
	NOT_EXISTS: 'not_exists',
	VERIFIED:   'verified',
	SENT:       'sent'
};

var verifier = require('email-verify');

var strWidth = 70;
var strHeight = 17;

var appDebug = require('debug')('app:debug'),
	appError = require('debug')('app:error');

var db = new DB();

app.use(express.static(path.join(__dirname, 'public')));


db.setup(checkInternet);
db.setup(checkInternet);

app.use(bodyparser.json()); // for parsing application/json
app.use(bodyparser.urlencoded({ extended: true })); // for parsing

app.post('/date-picker',function (req, res) {
	var start = moment(req.body.date_picker.date1,'DD-MM-YYYY');
	var end = moment(req.body.date_picker.date2,'DD-MM-YYYY');
	var dateRange = moment.range(start, end);
	var list = db.getSelectDataByDateRange(dateRange,function(err,done){
		if (done) {
			if (list.length>10000) {
				list = list.slice(0,10000);
			}
			res.send({data:list});
		}
	});
});

app.get('/svg',function(req,res){
	var file = __dirname + '/public/svg.html';
	res.sendFile(file);
});

function startApp(){
	io.on('connection',function(socket){
		var initData = db.getTotal(function(err,done){
			if (done) {
				io.emit('prepared',initData);
				appDebug("[INFO APP] SocketIO 发出初始化数据 '%s'", initData);
			}
		});

		// 成功获取了旧文件,并且是按倒序排列的
		db.getOldData(function(err,done,result){
			if (err) return;
			if (done) {
				// 过滤数据,排出17-1行,发给前台,line1-line16
				var lines = [];
				//for (var i=0; i<strHeight-1; i++) {
				var line = "";
				for (var i=0,j=0,len=result.length; i<len && j<(strHeight-1); i++){
					var obj = result[i];
					var content = obj.to+";";
					var status = obj.status;
					switch (status){
						case MAIL_STATUS.NOT_EXISTS:
							content = '░'.repeat(content.length);
							break;
						case MAIL_STATUS.VERIFIED:
							content = "▓".repeat(content.length);
							break;
						case MAIL_STATUS.SENT:
							content = '█'.repeat(content.length);
							break;
						default:
					}
					if (line.length<(strWidth-1-content.length)) {
						var spr = (line.length==0)? '':' ';
						line += spr+content;
					} else {
						line += ' '+"█".repeat(strWidth-line.length-1);
						lines[j] = line;
						j++;
						line = content;
					}
				}
				io.emit('oldData',lines);
				appDebug("[INFO APP] SocketIO 发出旧数据 '%s'", lines);
			}
		});

		socket.on('checkMail',function(data){
			setTimeout(function(){
				var mailAddress=AddrGenerator.gen();
				checkMail(mailAddress);
			},250);
		});
	});
	server.listen(4000,function(){
		var port = server.address().port;
		appDebug("[INFO APP] 'APP' 运行于 (localhost:%s)",port);
	});
};

function checkInternet(){
	require('dns').resolve('www.google.com', function(err) {
		if (err) {
			appDebug("[INFO APP]'INTERNET 连接' NOT WORK");
			return;
		}
		else {
			appDebug("[INFO APP]'INTERNET 连接' OK");
			startApp();
		}
	});
};

var checkMail = function(mailAddress){
	verifier.verify(mailAddress, function( err, info ){
		if( err ) {
			appDebug("[INFO APP] 邮件检测错误(%s)",err);
			var timeStamp = moment().format('L LTS Z');
			db.saveMessage({
				created_at: timeStamp,
				to: mailAddress,
				status: MAIL_STATUS.NOT_EXISTS
			}, function (err, done) {
			});
			io.emit('mailChecked', {mailAddress: mailAddress,checkFlag: 0});
		}
		else{
			if (info.success) {
				//TODO  这里要修改一下返回状态 ALL NOT EXISTS VERIFIED SENT
				var mailOptions = {
					from: 'aaajiao <aaajiao@t-h-e-s-p-a-c-e.com>', // sender address
					to: mailAddress, // list of receivers
					subject: '01100101 01101101 01100001 01101001 01101100', // Subject line
					html: mailContent // html body
				};
				transporter.sendMail(mailOptions, function(error, info){
					if(error){
						appDebug("[INFO APP] 向 '%s' 发出邮件失败(%s)", mailAddress,error);
						var timeStamp = moment().format('L LTS Z');
						db.saveMessage({
							created_at: timeStamp,
							to: mailAddress,
							status: MAIL_STATUS.VERIFIED
						}, function (err, done) {
						});
						io.emit('mailChecked', {mailAddress: mailAddress,checkFlag: 1});
					} else {
						appDebug("[INFO APP] 向 '%s' 发出邮件成功(%s)", mailAddress,info.response);
						var timeStamp = moment().format('L LTS Z');
						db.saveMessage({
							created_at: timeStamp,
							to: mailAddress,
							status: MAIL_STATUS.SENT
						}, function (err, done) {
						});
						io.emit('mailChecked', {mailAddress: mailAddress,checkFlag: 2});
					}
				});
			} else {
				appDebug("[INFO APP] 邮件检测失败(%s)",info.info);
				var timeStamp = moment().format('L LTS Z');
				db.saveMessage({
					created_at: timeStamp,
					to: mailAddress,
					status: MAIL_STATUS.NOT_EXISTS
				}, function (err, done) {
				});
				io.emit('mailChecked', {mailAddress: mailAddress,checkFlag: 0});
			}
			appDebug("[INFO APP] Success (T/F): " + info.success);
			appDebug("[INFO APP] Info: " + info.info );
		}

	});
};