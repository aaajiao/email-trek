/**
 * Created by Elvis on 15/10/23.
 */
"use strict";
const surnames = require('./lib/sur-names-min');
const maleNames = require('./lib/male-names-min');
const femaleNames = require('./lib/female-names-min');

function rand(l) {
	return Math.random() * l;
}

function getRandomName(list){
	let total_weight=0;
	for (let i in list){
		total_weight +=  list[i]/100;

	}
	let random_num = rand(total_weight);
	let weight_sum = 0;

	for (let i in list){
		weight_sum += list[i]/100;
		if (random_num <= weight_sum) {
			return i;
		}
	}
}

function getRandomJoin() {
	let joinStr;
	let r = Math.random();
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

module.exports = {
	MaleName: function () {
		return [
			getRandomName(surnames),
			getRandomName(maleNames)
		].join(getRandomJoin());
	},
	FemaleName: function () {
		return [
			getRandomName(surnames),
			getRandomName(femaleNames)
		].join(getRandomJoin());
	},
	FirstName: function() {
		return getRandomName(surnames);
	},
	AllName: function() {
		let r = Math.random();
		if (r<0.2) {
			return this.FirstName();
		} else if (r <.6) {
			return this.FemaleName();
		} else {
			return this.MaleName();
		}
	}
};