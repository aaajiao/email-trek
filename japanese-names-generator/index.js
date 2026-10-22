const surnames = require("./lib/surnames.json");
const maleNames = require("./lib/male-names.json");
const femaleNames = require("./lib/female-names.json");

function getRandomIndex(l) {
  return Math.floor(Math.random() * l);
}

function getRandomJoin() {
  var joinStr;
  var r = Math.random();
  if (r < 0.1) {
    joinStr = ".";
  } else if (r < 0.2) {
    joinStr = "-";
  } else if (r < 0.3) {
    joinStr = "_";
  } else {
    joinStr = "";
  }
  return joinStr;
}

module.exports = {
  MaleJapaneseName: function () {
    return [
      surnames[getRandomIndex(surnames.length)],
      maleNames[getRandomIndex(maleNames.length)],
    ].join(getRandomJoin());
  },
  FemaleJapaneseName: function () {
    return [
      surnames[getRandomIndex(surnames.length)],
      femaleNames[getRandomIndex(femaleNames.length)],
    ].join(getRandomJoin());
  },
  FirstName: function () {
    return surnames[getRandomIndex(surnames.length)];
  },
  AllName: function () {
    var r = Math.random();
    if (r < 0.2) {
      return this.FirstName();
    } else if (r < 0.6) {
      return this.FemaleJapaneseName();
    } else {
      return this.MaleJapaneseName();
    }
  },
};
