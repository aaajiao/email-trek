var dbConfig = {
	host: process.env.RDB_HOST || 'localhost',
	port: parseInt(process.env.RDB_PORT) || ****,
	db  : '*****',
	ctTable : ''*****','
};
var r = require('rethinkdbdash')({db:dbConfig.db}),
	moment = require('moment');
require('moment-range');

var dbDebug = require('debug')('database:debug'),
	dbError = require('debug')('database:error');
// #### Connection details

// RethinkDB database settings. Defaults can be overridden using environment variables.


/**
 * Connect to RethinkDB instance and perform a basic database setup:
 *
 * - create the `RDB_DB` database (defaults to `chat`)
 * - create tables `messages`, `cache`, `users` in this database
 */

function DB() {
	this.r = r;
}

DB.prototype.setup = function(func) {
	var self = this;
	var tableName = moment().format('YYYY_MM');
	self.r.tableList().run().then(function(result){
		if (result.indexOf(tableName)== -1) {
			self.r.tableCreate(tableName).run()
				.then(function(result){
					 dbDebug("[INFO DATABASE] RethinkDB '%s' Table '%s' 创建成功", dbConfig.db, tableName);
				 })
				.error(function(err){
					dbDebug("[DEBUG DATABASE] RethinkDB '%s' Table '%s' 已存在 (%s:%s)\n%s", dbConfig.db, tableName, err.name, err.msg, err.message);
				 });
		}
		func();
	}).error(function(err){
		dbError("[ERROR DATABASE] RethinkDB 获取表单失败 (%s:%s)\n%s",err.name, err.msg, err.message);
	});
};

DB.prototype.getOldData = function (callback){
	var self = this;
	var data;
	self.r.db(dbConfig.db).tableList().run()
		.then(function(result){
			var index = result.indexOf(dbConfig.ctTable);
			if (index > -1) {
				result.splice(index,1);
			}
			var last_modified='';
			var last_modified2 = '';
			last_modified = result.sort().pop();
			if (result.length){
				last_modified2 = result.sort().pop();
			}
			//console.log(last_modified,last_modified2);
			if (last_modified) {
				self.r.db(dbConfig.db).table(last_modified).orderBy(r.desc("created_at")).limit(100).run()
					.then(function (result) {
						var data = result;
						var cnt = result.length;
						if (cnt<100 && last_modified2!='') {
							self.r.db(dbConfig.db).table(last_modified2).orderBy(r.desc("created_at")).limit(100-cnt).run()
								.then(function (result) {
									data = data.concat(result);
									callback(null,true,data);
								})
								.error(function(err){
									callback(err);
								});
						} else {
							callback(null,true,data);
						}

					})
					.error(function(err){
						callback(err);
					});
			}
		})
		.error(function(err){
			//console.log('err!!!!');
			dbError("[ERROR DATABASE] RethinkDB 获取表单List失败 (%s:%s)\n%s", err.name, err.msg, err.message);
		});
	//return d1;
};

DB.prototype.getTotal = function (callback){
	var self = this;
	var initData = {
		not_exists:  0,
		verified:   0,
		sent:       0,
		//old_data   :{}
	};
	self.r.tableList().run().then(function(result){
		if (result.indexOf(dbConfig.ctTable) == -1) {
			self.r.tableCreate(dbConfig.ctTable).run()
				.then(function(result){
					self.r.table(dbConfig.ctTable).insert([{id:'not_exists',value:0},{id:'verified',value:0},{id:'sent',value:0}]).run()
						.then(function(result){
							dbDebug("[INFO DATABASE] RethinkDB '%s' Table '%s' 已创建", dbConfig.db, dbConfig.ctTable);
						})
						.error(function(err){
							dbDebug("[DEBUG DATABASE] RethinkDB '%s' Table '%s' 已存在 (%s:%s)\n%s", dbConfig.db, dbConfig.ctTable, err.name, err.msg, err.message);
						});
					// return reselt;
					callback(null,true);
				})
				.error(function(err){
					callback(err);
				});
		} else {
			self.r.table(dbConfig.ctTable).getAll('not_exists','verified','sent').orderBy('id').run()
				// TODO 测一下顺序
				.then(function(result){
					initData.not_exists = result[0].value;
					initData.verified = result[2].value;
					initData.sent  = result[1].value;
					callback(null,true);
					dbDebug("[INFO DATABASE] 从 RethinkDB '%s' Table '%s' 获取初始化数值", dbConfig.db, dbConfig.ctTable);
				});
		}
	}).error(function(err){
		dbError("[ERROR DATABASE] RethinkDB '%s' Table '%s' 获取表单失败 (%s:%s)\n%s", dbConfig.db, dbConfig.ctTable, err.name, err.msg, err.message);
		callback(err);
	});
	return(initData);
};

DB.prototype.getSelectDataByDateRange = function(dateRange,callback){
	var self = this;
	var list = [];
	self.getDateTableList(dateRange,function(result){
		var cnt= 0
		for (var i=0,len=result.length; i<len; i++) {
			var tableName = result[i];
			if (dateRange.contains(moment(tableName,'YYYY-MM'))){
				cnt++;
			}
		}
		//console.log(cnt);
		for (var i=0,len=result.length; i<len ;i++) {
			var tableName = result[i];
			if (dateRange.contains(moment(tableName,'YYYY-MM'))){
				self.getSelectDataByDateRangeInTable(result[i],dateRange,function(res){
					for (var i=0,len=res.length;i<len;i++) {
						var item = res[i];
						list.push(item);
					}
					cnt--;
					if (cnt==0){
						callback(null,true);
					}
				});
			}
			//console.log(result[i]);

		}
	});
	return list;
};

DB.prototype.getSelectDataByDateRangeInTable = function(tableName,dateRange,callback){
	var self = this;
	var list = [];
	self.r.table(tableName).run()
		.then(function(result){
			for (var i=0,len=result.length; i<len ;i++) {
				var item = result[i];
				if (dateRange.contains(moment(item.created_at,'L LTS Z'))) {
					list.push({status:item.status,to:item.to});
				}
			}
			callback(list);
		}).error(function(err){
		dbError("[ERROR DATABASE] RethinkDB '%s' Table '%s' 获取表单失败 (%s:%s)\n%s", dbConfig.db, dbConfig.ctTable, err.name, err.msg, err.message);
		callback(err);
	});
};

DB.prototype.getDateTableList = function(dateRange,callback){
	var self = this;
	var list = [];
	//TODO
	self.r.tableList().run().then(function(result){
		if (result.length>0){
			for (var i=0,len=result.length; i<len ;i++) {
				var tableName = result[i];
				if (tableName!=dbConfig.ctTable) {
					list.push(tableName);
				}
			}
			callback(list);
		}
		else callback(null,false);
	}).error(function(err){
		callback(err);
	});
	return list;
};

DB.prototype.saveMessage = function (msg,callback){
	var self = this;
	var tableName = moment().format('YYYY_MM');
	var writeMessage = function (result){
		self.r.table(tableName).insert(msg).run()
			.then(function(result){
				if(result.inserted === 1) {
					dbDebug("[INFO DATABASE] RethinkDB '%s' Table '%s' 数据已写入", dbConfig.db, tableName);
					callback(null, true);
					self.updateTotal(msg.status,function(err,done){
						if (done) {
						}
					});
				}
				else {
					dbDebug("[INFO DATABASE] RethinkDB '%s' Table '%s' 数据未写入", dbConfig.db,  dbConfig.ctTable);
					callback(null, false);
				}
			})
			.error(function(err){
				dbError("[ERROR DATABASE] RethinkDB '%s' Table '%s' 数据写入错误 (%s:%s)\n%s", dbConfig.db, tableName, err.name, err.msg, err.message);
				callback(err);
			});
	};
	self.r.tableList().run()
		.then(function(result){
			if (result.indexOf(tableName)== -1) { //表单不存在
				//创建表单;
				self.r.tableCreate(tableName).run()
					.then(function(result){
						dbDebug("[INFO DATABASE] RethinkDB '%s' Table '%s' 表单已创建", dbConfig.db, tableName);
					})
					.then(writeMessage(result))
					.error(function(err){
						dbDebug("[DEBUG DATABASE] RethinkDB '%s' Table '%s' 表单已存在 (%s:%s)\n%s", dbConfig.db, tableName, err.name, err.msg, err.message);
					});
			} else {
				writeMessage(result);
			}
		})
		.error(function(err){
			dbError("[ERROR DATABASE] RethinkDB 获取表单List失败 (%s:%s)\n%s", err.name, err.msg, err.message);
		});
};

DB.prototype.updateMessage = function (msg,callback){
	var self = this;
	var tableName = moment().format('YYYY_MM');

	self.r.table(tableName).get(msg.id).update(msg.content).run()
		.then(function(result){
			if(result.replaced === 1) {
				dbDebug("[INFO DATABASE] RethinkDB '%s' Table '%s' 表单已创建", dbConfig.db, tableName);
				callback(null, true);
				self.updateTotal(msg.content.status,function(err,done){
					if (done) {
					}
				});
			}
			else if (result.skipped === 1) {
				tableName = moment().day(-7).format('YYYY_MM');
				self.r.table(tableName).get(msg.id).update(msg.content).run()
					.then(function(result){
						if(result.replaced === 1) {
							dbDebug("[INFO DATABASE] Table '%s' Row '%s 已更新", tableName, msg.id);
							callback(null, true);
							self.updateTotal(msg.content.status,function(err,done){
								if (done) {
								}
							});
						} else {
							dbDebug("[DEBUG DATABASE] Table '%s' Row '%s 未找到", tableName, msg.id);
							callback(null, false);
						}
					})
					.error(function(err){
						dbError("[DEBUG DATABASE] Table '%s' Row '%s 更新错误 %s:%s\n%s", err.name, err.msg, err.message);
						callback(err);
					});
			} else {
				callback(null, false);
			}
		})
		.error(function(err){
			dbError("[DEBUG DATABASE] Table '%s' Row '%s 更新错误 %s:%s\n%s", err.name, err.msg, err.message);
			callback(err);
		});
};

DB.prototype.updateTotal = function (id,callback){
	var self = this;
	//console.log(id);
	self.r.table(dbConfig.ctTable).get(id).update({value:r.row('value').add(1)}).run()
		.then(function(result){
			if(result.replaced === 1) {
				dbDebug("[INFO DATABASE] RethinkDB '%s' Table '%s' 计数已更新", dbConfig.db,  dbConfig.ctTable);
				callback(null, true);
			}
			else {
				dbDebug("[DEBUG DATABASE] RethinkDB '%s' Table '%s' 计数未更新", dbConfig.db,  dbConfig.ctTable);
				callback(null, false);
			}
		})
		.error(function(err){
			dbError("[ERROR DATABASE] RethinkDB '%s' Table '%s' 计数更新错误 (%s:%s)\n%s", dbConfig.db,  dbConfig.ctTable, err.name, err.msg, err.message);
			callback(err);
		});
};

module.exports = DB;
