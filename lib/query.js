/**
 * XadillaX created at 2014-09-09 10:05
 *
 * Copyright (c) 2014 Huaban.com, all rights
 * reserved.
 */
var util = require("util");
var Yukari = require("./yukari");
var mysql = require("mysql");
var async = require("async");
var Scarlet = require("scarlet-task");
var escaper = require("./escaper");

/**
 * limit array to limit object
 * @param limitArray
 * @returns {{skip: *, limit: *}}
 * @private
 */
function _limitArrayToObject(limitArray) {
    var obj = {
        skip    : limitArray[0],
        limit   : limitArray[1]
    };

    if(undefined === obj.limit) {
        obj.limit = obj.skip;
        obj.skip = 0;
    }
    if(undefined === obj.skip) {
        obj.skip = 0;
        obj.limit = 1;
    }

    obj.skip = parseInt(obj.skip);
    obj.limit = parseInt(obj.limit);

    return obj;
}

/**
 * limit string to limit object
 * @param limitString
 * @returns {{skip: *, limit: *}}
 * @private
 */
function _limitStringToObject(limitString) {
    return _limitArrayToObject(limitString.split(","));
}

/**
 * sql query object
 * @param model
 * @constructor
 */
var Query = function(model) {
    this.model = model;
    this.toshihiko = model.toshihiko;

    this.condition = {};
    this.fields = this.model._fieldsObject.map(function(field) {
        return field.name;
    });
    this._order = null;
    this._limit = null;

    // memcached
    this.memcached = model.memcached;

    this.updateData = {};
};

/**
 * get original field name
 * @param field
 * @returns {*}
 * @private
 */
Query.prototype._getOrigFieldName = function(field) {
    var f = this.model._fieldsObject.find(function(f) {
        return f.alias === field || f.name === field;
    });
    if(undefined === f) return null;
    return f.name;
};

/**
 * make condition for one certain field
 * @param condition
 * @param field
 * @param type
 * @private
 */
Query.prototype._makeConditionField = function(condition, field, type) {
    var self = this;

    // alias...
    var _field = field;
    field = this.model._fieldsObject.find(function(f) {
        return f.alias === _field || f.name === _field;
    });
    if(undefined === field) return "";

    // if it's not an object
    if(typeof condition !== "object") {
        var sql = "`" + field.name + "` = ";
        sql += (field.type.needQuotes ? "\"" + escaper.escape(condition) + "\"" : condition);

        return sql;
    }

    var size = Object.size(condition);
    var keys = Object.keys(condition);
    if(!size) return "";

    // get each condition strings
    var conditionStrings = [];
    for(var i = 0; i < keys.length; i++) {
        var key = keys[i].toLowerCase();

        var value = condition[keys[i]];
        var symbol = null;

        // and / or logic
        if(key === "$and" || key === "$or") {
            // array supported
            //   eg. $or: [ "127.0.0.1", "localhost" ]
            if(!util.isArray(value)) value = [ value ];

            var type = key.substr(1);
            var temp = [];
            value.map(function(value) {
                var sql = self._makeConditionField(value, field.name, type);
                temp.push(sql);
            });

            var tempString = "";
            for(var i = 0; i < temp.length; i++) {
                if(i) tempString += " " + type.toUpperCase() + " ";
                tempString += temp[i];
            }

            conditionStrings.push(tempString);

            continue;
        }

        // general operations...
        switch(key) {
            case "$eq":
            case "===": symbol = "="; break;

            case "$neq":
            case "!==": symbol = "!="; break;

            case "$lt":
            case "<": symbol = "<"; break;

            case "$gt":
            case ">": symbol = ">"; break;

            case "$lte":
            case "<=": symbol = "<="; break;

            case "$gte":
            case ">=": symbol = ">="; break;

            case "$like": symbol = "like"; break;

            // in... (if necessary)

            default: break;
        }

        // symbol is general operation above
        if(symbol) {
            // null, not null...
            if(value === null) {
                if(symbol === "=") {
                    conditionStrings.push("`" + field.name + "` IS NULL");
                    continue;
                }
                if(symbol === "!=") {
                    conditionStrings.push("`" + field.name + "` IS NOT NULL");
                    continue;
                }
            }

            // array supported:
            //   eg. { field: { $neq: [ "123", "456" ] } }
            if(!util.isArray(value)) value = [ value ];

            value.map(function(value) {
                var cdt = "`{field}` {symbol} {value}".assign({
                    field       : field.name,
                    symbol      : symbol,
                    value       : (field.type.needQuotes ? "\"" + escaper.escape(value) + "\"" : value)
                });

                conditionStrings.push(cdt);
            });

            continue;
        }

        // TODO: maybe other operations...
    }

    // splice conditions
    var result = "";
    for(var i = 0; i < conditionStrings.length; i++) {
        if(i) result += " " + type.toUpperCase() + " ";
        result += conditionStrings[i];
    }

    return "(" + result + ")";
};

/**
 * make condition
 * @param condition
 * @param type
 * @private
 */
Query.prototype._makeCondition = function(condition, type) {
    var size = Object.size(condition);
    var keys = Object.keys(condition);
    if(!size) return "";

    var part = [];

    for(var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if(key === "$and") {
            part.push(this._makeCondition(condition[key], "and"));
            continue;
        }
        if(key === "$or") {
            part.push(this._makeCondition(condition[key], "or"));
            continue;
        }

        // if it's not logic, then I default it is a field
        var sql = this._makeConditionField(condition[key], key, "and");
        part.push(sql);
    }

    // splice conditions
    var result = "";
    for(var i = 0; i < part.length; i++) {
        if(i) result += " " + type.toUpperCase() + " ";
        result += part[i];
    }

    return "(" + result + ")";
};

/**
 * make order
 * @returns {*}
 * @private
 */
Query.prototype._makeOrder = function() {
    if(!this._order) return "";

    var type = typeof this._order;
    if(type === "string") return this._order;

    if(util.isArray(this._order)) {
        return this._order.reduce(function(order, o) {
            if(order !== "") order += ", ";
            order += o;
            return order;
        }, "");
    }

    var result = "";
    for(var key in this._order) {
        var _key = key;
        key = this._getOrigFieldName(key);
        if(!key) continue;

        if(result !== "") result += ", ";
        result += key;

        var v = this._order[_key].toString().toUpperCase();
        if(v === "ASC" || v === "DESC") {
            result += " " + v;
        } else {
            result += " " + (parseInt(v) >= 0 ? "ASC" : "DESC");
        }
    }

    return result;
};

/**
 * make set
 * @returns {*}
 * @private
 */
Query.prototype._makeSet = function() {
    var fields = this.model._fieldsObject;

    var arr = [];
    var str = "";
    for(var key in this.updateData) {
        if(str !== "") str += ", ";

        var v = this.updateData[key];
        var name = "";
        for(var i = 0; i < fields.length; i++) {
            if(fields[i].name === key || fields[i].alias === key) {
                name = fields[i].name;
                break;
            }
        }

        if(name === "") continue;

        str += "`" + name + "` = ";

        // raw data...
        //   eg. {{i + 1}}
        if(typeof v === "string" && v.length >= 4 && v[0] === '{' && v[1] === '{' && v[v.length - 2] === '}' && v[v.length - 1] === '}') {
            str += v.substr(2, v.length - 4);
        } else {
            str += "?";
            arr.push(v);
        }
    }

    return mysql.format(str, arr);
};

/**
 * make limit sql
 * @param [limitOnly]
 * @returns {string}
 * @private
 */
Query.prototype._makeLimit = function(limitOnly) {
    if(!this._limit) return;

    var limit;
    var type = typeof this._limit;
    if(type === "string") limit = _limitStringToObject(this._limit);
    else
    if(util.isArray(this._limit)) limit = _limitArrayToObject(this._limit);
    else limit = this._limit;

    if(limitOnly) return limit.limit;
    return limit.skip + ", " + limit.limit;
};

/**
 * make delete sql
 * @returns {String|void|*}
 * @private
 */
Query.prototype._makeSQLDelete = function() {
    sql = "DELETE FROM `{name}` ".assign({ name: this.model.name });
    if(Object.size(this.condition)) {
        sql += "WHERE ";
        sql += this._makeCondition(this.condition, "and");
    }

    if(this._order) {
        sql += " ORDER BY " + this._makeOrder();
    }

    if(this._limit) {
        sql += " LIMIT " + this._makeLimit(true);
    }

    return sql;
};

/**
 * make update sql
 * @returns {String|void}
 * @private
 */
Query.prototype._makeSQLUpdate = function() {
    var _idx = 0;
    var sql = "UPDATE `{name}` SET ".assign({ name: this.model.name });
    sql += this._makeSet();

    if(Object.size(this.condition)) {
        sql += " WHERE ";
        sql += this._makeCondition(this.condition, "and");
    }

    return sql;
};

/**
 * make find sql
 * @returns {*|Mixed}
 * @private
 */
Query.prototype._makeSQLFind = function() {
    var _idx = 0;
    var sql = this.fields.reduce(function(sql, field) {
        sql += _idx++ ? ", " : " ";
        return sql + "`" + field + "`";
    }, "SELECT");

    sql += " FROM `{name}` ".assign({ name: this.model.name });

    if(Object.size(this.condition)) {
        sql += "WHERE ";
        sql += this._makeCondition(this.condition, "and");
    }

    if(this._order) {
        sql += " ORDER BY ";
        sql += this._makeOrder();
    }

    if(this._limit) {
        sql += " LIMIT ";
        sql += this._makeLimit();
    }

    return sql;
};

/**
 * make query SQL
 * @param method
 * @returns {string}
 */
Query.prototype.makeSQL = function(method) {
    method = method.toLowerCase();
    var result = "";

    switch(method) {
        case "update": result = this._makeSQLUpdate(); break;
        case "delete": result = this._makeSQLDelete(); break;
        case "find":
        default: result = this._makeSQLFind(); break;
    }

    return result;
};

/**
 * give order
 * @param order
 * @returns {Query}
 */
Query.prototype.orderBy = function(order) {
    this._order = order;
    return this;
};

/**
 * give limit
 * @param limit
 * @returns {Query}
 */
Query.prototype.limit = function(limit) {
    this._limit = limit;
    return this;
};

/**
 * give conditions
 * @param condition
 * @returns {Query}
 */
Query.prototype.where = function(condition) {
    this.condition = condition;
    return this;
};

/**
 * set fields
 * @param fields
 */
Query.prototype.field = function(fields) {
    if(util.isArray(fields)) {
        this.fields = fields;
        return this;
    }
    this.fields = fields.split(",").remove("");
    return this;
};

/**
 * update records via condition
 * @param data
 * @param callback
 */
Query.prototype.update = function(data, callback) {
    if(undefined === callback) callback = function(){};

    this.updateData = data;

    var sql = this.makeSQL("update");
    if(this.toshihiko.options.showSql) {
        console.log("❤️ Toshihiko is executing SQL: 【" + sql + "】...");
    }

    var self = this;
    var primaryKeys, tempFields;
    async.waterfall([
        /**
         * step 1.
         *   if use MEMCACHED, delete it from MEMCACHED
         * @param callback
         * @returns {*}
         */
        function(callback) {
            if(!self.model.memcached) return callback();

            primaryKeys = self.model.getPrimaryKeysName();
            tempFields = self.fields;
            self.fields = (typeof primaryKeys === "string") ? [ primaryKeys ] : primaryKeys;

            var relatedSql = self.makeSQL("query");

            // find related rows
            self.toshihiko.execute(relatedSql, function(err, result) {
                if(err) return callback(err);
                self.model.memcached.deleteKeys(self.toshihiko.database, self.model.name, result, function(err) {
                    self.fields = tempFields;

                    return callback(err);
                });
            });
        },

        /**
         * step 2.
         *   execute SQL
         * @param callback
         */
        function(callback) {
            self.toshihiko.execute(sql, callback);
        }
    ], function(err, result) {
        callback(err, result, sql);
    });
};

/**
 * delete record(s)
 * @param callback
 */
Query.prototype.delete = function(callback) {
    if(undefined === callback) callback = function(){};

    var self = this;
    var sql = this.makeSQL("delete");
    if(this.toshihiko.options.showSql) {
        console.log("❤️ Toshihiko is executing SQL: 【" + sql + "】...");
    }

    var primaryKeys, tempFields;
    async.waterfall([
        /**
         * step 1.
         *   if use MEMCACHED, delete it from MEMCACHED
         * @param callback
         * @returns {*}
         */
        function(callback) {
            if(!self.model.memcached) return callback();

            primaryKeys = self.model.getPrimaryKeysName();
            tempFields = self.fields;
            self.fields = (typeof primaryKeys === "string") ? [ primaryKeys ] : primaryKeys;

            var relatedSql = self.makeSQL("query");

            // find related rows
            self.toshihiko.execute(relatedSql, function(err, result) {
                if(err) return callback(err);
                self.model.memcached.deleteKeys(self.toshihiko.database, self.model.name, result, function(err) {
                    self.fields = tempFields;

                    return callback(err);
                });
            });
        },

        /**
         * step 2.
         *   execute SQL
         * @param callback
         */
        function(callback) {
            self.toshihiko.execute(sql, callback);
        }
    ], function(err, rows) {
        callback(err, rows, sql);
    });
};

/**
 * find just one record
 * @param callback
 */
Query.prototype.findOne = function(callback) {
    var limitType = typeof this._limit;
    if(null === this._limit) {
        this._limit = {
            skip    : 0,
            limit   : 1
        }
    } else {
        if(limitType === "string") {
            this._limit = _limitStringToObject(this._limit);
        }
        if(util.isArray(this._limit)) {
            this._limit = _limitArrayToObject(this._limit);
        }
    }

    this._limit.limit = 1;
    this.find(function(err, rows, sql) {
        if(err) return callback(err, undefined, sql);
        if(!rows.length) return callback();
        callback(undefined, rows[0], sql);
    });
};

/**
 * execute a certain SQL
 * @param sql
 * @param [format]
 * @param callback
 * @returns {Query}
 */
Query.prototype.execute = function(sql, format, callback) {
    if(this.toshihiko.options.showSql) {
        console.log("❤️ Toshihiko is executing SQL: 【" + sql + "】...");
    }

    if(typeof format === "function") {
        callback = format;
        format = undefined;
    }

    if(undefined === callback) callback = function(){};

    if(format) {
        sql = mysql.format(sql, format);
    }

    this.toshihiko.execute(sql, function(err, result) {
        callback(err, result);
    });

    return this;
};

/**
 * is memcached fit with primary key
 * @param inPk
 * @param data
 * @returns {boolean}
 * @private
 */
Query.prototype._memcachedFitWithPrimary = function(inPk, data) {
    for(var key in inPk) {
        if(inPk[key] !== data[key]) return false;
    }
    return true;
};

/**
 * find records
 * @param callback
 */
Query.prototype.find = function(callback) {
    var self = this;

    // no memcached
    if(!this.model.memcached) {
        var sql = this.makeSQL("find");
        if(this.toshihiko.options.showSql) {
            console.log("❤️ Toshihiko is executing SQL: 【" + sql + "】...");
        }

        this.toshihiko.execute(sql, function(err, rows) {
            if(err) return callback(err, undefined, sql);

            for(var i = 0; i < rows.length; i++) {
                var yukari = new Yukari(self.model, "query");
                yukari._initRow(rows[i]);
                rows[i] = yukari;
            }

            callback(undefined, rows, sql);
        });
    } else {
        // force add primary key
        var primayKeys = this.model.getPrimaryKeysName();
        if(typeof primayKeys === "string") {
            this.fields.push(primayKeys);
        } else {
            this.fields.add(primayKeys);
        }

        // find primary keys at first
        var tempFields = this.fields;
        this.fields = (typeof primayKeys === "string") ? [ primayKeys ] : primayKeys;

        var sql = this.makeSQL("find");
        if(this.toshihiko.options.showSql) {
            console.log("❤️ Toshihiko is executing SQL: 【" + sql + "】...");
        }

        this.toshihiko.execute(sql, function(err, rows) {
            if(err) {
                self.fields = tempFields;
                return callback(err, undefined, self.makeSQL("find"));
            }

            // give rows to find in memcached
            self.model.memcached.getData(self.toshihiko.database, self.model.name, rows, function(err, data) {
                if(err) {
                    data = [];
                }

                var result = [];

                // fill in memcached result
                var offset = 0;
                var unfetchedCount = 0;
                for(var i = 0; i < rows.length; i++) {
                    var d = data.find(function(n) {
                        return self._memcachedFitWithPrimary(rows[i], n);
                    });

                    if(d !== undefined) {
                        data[offset].$fromMemcached = true;
                        result.push(data[offset++]);
                    } else {
                        result.push(undefined);
                        unfetchedCount++;
                    }
                }

                // fetch from mysql...
                var scarlet = new Scarlet(10);

                var errs = [];
                var taskDone = function(TO) {
                    if(undefined !== TO) scarlet.taskDone(TO);
                    if(scarlet.numberOfProcessed() !== unfetchedCount) return;
                    var err = errs.length ? errs[0] : undefined;

                    var delKeys = [];
                    for(var i = 0; i < self.model._fieldsObject.length; i++) {
                        if(tempFields.indexOf(self.model._fieldsObject[i].alias) === -1) {
                            delKeys.push(self.model._fieldsObject[i].name);
                        }
                    }

                    result = result.compact().map(function(row) {
                        // delete some keys
                        for(var i = 0; i < delKeys.length; i++) {
                            delete row[delKeys[i]];
                        }

                        var yukari = new Yukari(self.model, "query");
                        yukari._initRow(row);
                        return yukari;
                    });

                    callback(err, result);
                };

                var fetchFromMySQL = function(TO) {
                    var idx = TO.task;
                    var query = new Query(self.model);
                    var sql = query.where(rows[idx]).makeSQL("find");

                    // ❤️ TRUE QUERY IN MYSQL ❤️
                    self.toshihiko.execute(sql, function(err, row) {
                        if(err) {
                            errs.push(err);
                            return taskDone(TO);
                        }

                        if(!row.length) {
                            return taskDone(TO);
                        }

                        row = row[0];

                        // set MEMCACHED... 啊哈哈哈
                        self.model.memcached.setData(self.toshihiko.database, self.model.name, rows[idx], row, function(err) {
                            //if(err) {
                                // not important, just leave it blank
                            //}

                            result[idx] = row;
                            taskDone(TO);
                        });
                    });
                };

                var count = 0;
                for(var i = 0; i < rows.length; i++) {
                    if(undefined === result[i]) {
                        count++;
                        scarlet.push(i, fetchFromMySQL);
                    }
                }

                if(!count) {
                    taskDone();
                }
            });
        });
    }
    return this;
};

module.exports = Query;