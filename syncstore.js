/*

@license Copyright (C) 2014 Frederik Hannibal <frederik@backhand.dk>

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

*/

(function(window, angular, undefined) {
  'use strict';

  // debounce function borrowed from underscore
  // so as not to introduce a dependency because
  // of one function
  var _now = Date.now || function() { return new Date().getTime(); };
  var _debounce = function(func, wait, immediate) {
    var timeout;
    var args;
    var context;
    var timestamp;
    var result;

    var later = function() {
      var last = _now() - timestamp;

      if (last < wait && last > 0) {
        timeout = setTimeout(later, wait - last);
      } else {
        timeout = null;
        if (!immediate) {
          result = func.apply(context, args);
          context = args = null;
        }
      }
    };

    return function() {
      context = this;
      args = arguments;
      timestamp = _now();
      var callNow = immediate && !timeout;
      if (!timeout) {
        timeout = setTimeout(later, wait);
      }
      if (callNow) {
        result = func.apply(context, args);
        context = args = null;
      }

      return result;
    };
  };

  function setImmutableProperty(obj, key, val, enumerable) {
    Object.defineProperty(obj, key, {
      value: val,
      writable: false,
      enumerable: !!enumerable,
      configurable: false
    });
  }
  function defineGetterSetter(obj, key, val) {
    Object.defineProperty(obj, key, {
      enumerable: false,
      configurable: false,
      get: val,
      set: val
    });
  }
  function setHiddenProperty(obj, key, val, getter) {
    Object.defineProperty(obj, key, {
      writable: true,
      value: val,
      enumerable: false,
      configurable: false
    });
  }

  function query(property, val) {
    var q = {};
    q[property] = val;
    return q;
  }

  angular.module('SyncStore', ['ngResource']).
    factory('SyncStore', ['$q', '$resource', '$rootScope',
      function($q, $resource, $rootScope) {

        if (!$rootScope.stores) {
          $rootScope.stores = [];
        }

        // Volatile local id, used for quick identification
        // of objects created locally
        var localIdSequence = 1;

        function SyncStoreItem(obj, syncStore) {
          setHiddenProperty(this, 'original', angular.copy(obj));

          syncStore.hiddenItemProperties.forEach(function(property) {
            setHiddenProperty(this, property);
          }, this);

          setImmutableProperty(this, '_id_property', syncStore.idProperty);
          setImmutableProperty(this, '_local_id', localIdSequence++);

          if (syncStore.params.extend) {
            var self = this;
            angular.forEach(syncStore.params.extend, function(val, key) {
              if (typeof val === 'function') {
                defineGetterSetter(self, key, val);
              } else {
                setHiddenProperty(self, key, val);
              }
            });
          }

          if (obj !== this) {
            angular.copy(obj, this);
          }
        }

        SyncStoreItem.prototype.hasChanged = function() {
          return !angular.equals(this, this.original);
        };

        SyncStoreItem.prototype.update = function(obj) {
          angular.extend(this, obj);
          return this;
        };

        SyncStoreItem.prototype.setUpdated = function() {
          angular.extend(this.original, this);
          return this;
        };

        function SyncStore(params) {
          var self = this;

          var syncStoreItemEnhance = function(obj) {
            if (obj.__proto__) {
              obj.__proto__ = SyncStoreItem.prototype;
            } else {
              angular.extend(obj, SyncStoreItem.prototype);
            }

            SyncStoreItem.call(obj, obj, self);

            return obj;
          };

          setHiddenProperty(this, 'params', params);

          // Item hidden properties - useful for volatile
          // ui state like selected etc.
          setHiddenProperty(this, 'hiddenItemProperties', params.hiddenItemProperties || []);

          // Property name to store data under rootScope
          var storeId = params.storeId;
          setImmutableProperty(this, 'storeId', storeId, true);

          // Base url of this resource
          var url = params.url;

          // Threshold item count - beyond this operations will be
          // proxied to remote - not implemented yet
          var threshold = params.threshold;

          // Property of remote identifier, e.g. 'id' or 'userId'
          var idProperty = params.idProperty;
          setImmutableProperty(this, 'idProperty', idProperty, true);

          // Resource methods
          var methods = params.methods;

          // Whether to $watch on data store array or not
          var autoSync = params.autoSync === undefined ? true : !!params.autoSync;

          // Flag indicating whether any data has been loaded yet
          var dataLoaded = false;

          // Check input
          if (!storeId) {
            throw new Error('SyncStore: No storeId');
          }
          if (!url) {
            throw new Error('SyncStore: No URL');
          }
          if (!idProperty) {
            throw new Error('SyncStore: No id property');
          }

          // Create embedded resource
          var resource = $resource(url, {}, methods);
          setImmutableProperty(this, 'resource', resource, true);

          // Map of existing local ids
          var localIds = {};

          // Map of remote ids existing locally
          var remoteIds = {};

          // Create data container on rootScope
          var storeData = $rootScope.stores[this.storeId] = [];
          setHiddenProperty(this, 'store', storeData);
          setHiddenProperty(storeData, 'byId', remoteIds);

          var storeDeferred = $q.defer();
          setHiddenProperty(storeData, 'promise', storeDeferred.promise);

          var add = function(item) {
            var itemId = item[idProperty];
            var localItem = remoteIds[itemId];

            // New item from remote - add it to store
            if (!localItem) {
              var storeItem = new SyncStoreItem(item, self);

              localIds[storeItem._local_id] = storeItem;
              remoteIds[itemId] = storeItem;

              $rootScope.stores[storeId].push(storeItem);
              self.emit('create_remote', storeItem);
              return storeItem;
            }

            // Check if it was updated remote
            if (!angular.equals(item, localItem)) {
              // Overwrite local item
              // TODO: Check timestamp property and
              //       select latest object
              localItem.update(item).setUpdated();
              self.emit('update_remote', item, localItem);
              localItem.emit('update_remote', item, localItem);
            }

            return localItem;
          };

          window['lri_' + storeId] = function() {
            console.log('syncstore.js:244 - remoteIds', remoteIds);
          };

          var remove = function(item) {
            var localId = item._local_id;
            // console.log('remove %s', localId, item);

            var deleteIndex = $rootScope.stores[storeId].indexOf(item);
            $rootScope.stores[storeId].splice(deleteIndex, 1);
            delete remoteIds[item[idProperty]];
            delete localIds[localId];
            self.emit('delete_remote', item);
          };

          var removeByRemoteId = function(remoteId) {
            var item = remoteIds[remoteId];
            remove(item);
          };

          var syncItem = this.syncItem = function(remoteId, callback) {
            resource.get(query(idProperty, remoteId), function(item) {
              // console.log('syncItem', item);
              item = add(item);
              if (typeof callback === 'function') {
                callback(null, item);
              }
            }, function(err) {
              // console.log('contact err', err);
              if (err.status === 404 && remoteIds[remoteId]) {
                // If it exists locally, assume it was deleted on the other end
                removeByRemoteId(remoteId);
              }

              if (typeof callback === 'function') {
                callback(err);
              }
            }, function(status) {
              // console.log('syncstore.js:254 - status', status);
            });
          };

          var getById = this.getById = function(id, forceFetch) {
            if (!dataLoaded || !remoteIds[id] || forceFetch) {
              // console.log('syncstore.js:260 - !dataLoaded, !remoteIds[id], forceFetch',
              // !dataLoaded, !remoteIds[id], forceFetch);
              var deferred = $q.defer();

              var doSyncItem = function() {
                syncItem(id, function(err, item) {
                  if (err) {
                    console.log('syncstore.js:263 - err', err);
                    return deferred.reject(err);
                  }

                  deferred.resolve(item);
                });
              };

              if (!dataLoaded) {
                self.once('load', function() {
                  if (remoteIds[id] && !forceFetch) {
                    deferred.resolve(remoteIds[id]);
                  } else {
                    doSyncItem();
                  }
                });
              } else {
                doSyncItem();
              }

              return deferred.promise;
            } else {
              return remoteIds[id];
            }
          };

          this.onData = function(data) {
            if (!dataLoaded) {
              self.suppressEvents(true);
            }

            // All items are to be removed unless they exist on the other end
            // - keep track of them here
            var toRemove = angular.copy(remoteIds);

            // console.log('remoteIds', remoteIds);
            angular.forEach(data, function(item) {
              var itemId = item[idProperty];

              // Item still exists, don't remove it
              delete toRemove[itemId];

              add(item);
            });

            // Remove those deleted remotely
            angular.forEach(toRemove, function(item, localId) {
              remove(item);
            });

            if (!dataLoaded) {
              self.suppressEvents(false);
              dataLoaded = true;
              storeDeferred.resolve(storeData);
            }

            self.emit('load');
          };

          var watcher = function(newValue, oldValue) {
            var toDelete = angular.copy(localIds);
            var toCreate = {};
            var toCreateArray;
            var toUpdate = {};

            $rootScope.stores[storeId].forEach(function(item, index) {
              if (item._local_id) {
                // Still here, remove from toDelete list
                delete toDelete[item._local_id];

                if (item.hasChanged()) {
                  toUpdate[item._local_id] = item;
                }
              } else {
                // New item, add to toCreate list
                // var newItem = new SyncStoreItem(item, self);
                syncStoreItemEnhance(item, self);
                var newItem = item;
                $rootScope.stores[storeId][index] = newItem;
                localIds[newItem._local_id] = newItem;
                toCreate[newItem._local_id] = newItem;
              }
            });

            // Call delete on all toDelete entries
            angular.forEach(toDelete, function(item, localId) {
              // var params = {};
              // params[idProperty] = item[idProperty];
              // console.log('Delete %s', localId, item, params);
              resource.delete(query(idProperty, item[idProperty]), function() {
                self.emit('delete', item);
                item.emit('delete', item);
                delete localIds[localId];
                delete remoteIds[item[idProperty]];
              });
            });

            if (resource.bulkCreate) {
              // If the resource supports bulk creation do a single call and map results back to items
              toCreateArray = _.map(toCreate, function(item) {
                return item;
              });

              resource.bulkCreate(toCreateArray, function(results) {
                results.forEach(function(result, i) {
                  var item = toCreateArray[i];
                  item.emit('create', result, item);
                  remoteIds[result[idProperty]] = item;
                  item.update(result).setUpdated();
                });

                if (results.length) {
                  self.emit('create', results);
                }
              });
            } else {
              // Call create on all toCreate entries
              angular.forEach(toCreate, function(item, localId) {
                //console.log('Create %s', localId, item);
                resource.create(item, function(result) {
                  self.emit('create', result, item);
                  item.emit('create', result, item);
                  remoteIds[result[idProperty]] = item;
                  item.update(result).setUpdated();
                });
              });
            }

            // Call update on all toUpdate entries
            angular.forEach(toUpdate, function(item, localId) {
              resource.save(item, function(result) {
                self.emit('update', result, item);
                item.emit('update', result, item);
                item.update(result).setUpdated();
              });
            });
          };
          this.sync = watcher;

          setHiddenProperty(storeData, 'add', function(obj) {
            $rootScope.stores[self.storeId].push(obj);
            self.sync();
            return obj;
          });
          setHiddenProperty(storeData, 'rm', function(obj) {
            $rootScope.stores[self.storeId].splice($rootScope.stores[self.storeId].indexOf(obj), 1);
            self.sync();
            return obj;
          });
          setHiddenProperty(storeData, 'getById',  getById);

          // Watch for changes, debounce to 3 secs
          var watchStore;
          if (this.autoSync) {
            watchStore = $rootScope.$watch('stores.' + this.storeId, _debounce(watcher, 3000, true), true);
          }

        }

        SyncStore.prototype.load = function() {
          var self = this;
          this.resource.query({
            limit: this.threshold,
            offset: 0
          }, this.onData, function(err) {
            self.emit('error', err);
          });
          return this;
        };

        SyncStore.prototype.on = SyncStoreItem.prototype.on = function on(name, fn) {
          this._listeners = this._listeners || {};
          // console.log('Adding %s listener', name, fn);
          this._listeners[name] = this._listeners[name] || [];
          this._listeners[name].push(fn);

          return this;
        };

        SyncStore.prototype.once = SyncStoreItem.prototype.once = function once(name, fn) {
          this._listeners_once = this._listeners_once || {};

          this._listeners_once[name] = this._listeners_once[name] || [];
          this._listeners_once[name].push(fn);

          return this;
        };

        SyncStore.prototype.off = SyncStoreItem.prototype.off = function off(name, fn) {
          this._listeners = this._listeners || {};

          if (this._listeners[name]) {
            var index = this._listeners[name].indexOf(fn);
            if (index >= 0) {
              this._listeners[name].splice(index, 1);
            }
          }

          return this;
        };

        SyncStore.prototype.emit = SyncStoreItem.prototype.emit = function emit(name) {
          if (this._suppressEvents) { return; }

          this._suppressedEvents = this._suppressedEvents || {};
          if (this._suppressedEvents[name]) {
            return;
          }

          var eventArgs = Array.prototype.slice.call(arguments, 1);

          // TODO: store event args in array and debounce
          // event listener actions by about 2-3 seconds
          // console.log('Calling %s', name, eventArgs);
          this._listeners = this._listeners || {};
          this._listeners_once = this._listeners_once || {};
          if (this._listeners[name]) {
            for (var i in this._listeners[name]) {
              this._listeners[name][i].apply(this, eventArgs);
            }
          }

          if (this._listeners_once[name]) {
            for (var i in this._listeners_once[name]) {
              this._listeners_once[name][i].apply(this, eventArgs);
            }
            this._listeners_once[name] = [];
          }

        };

        SyncStore.prototype.suppressEvents = function(flag) {
          this._suppressedEvents = this._suppressedEvents || {};

          if (typeof flag === 'boolean') {
            this._suppressEvents = flag === undefined ? !this._suppressEvents : !!flag;
          }

          if (typeof flag === 'object') {
            _.extend(this._suppressedEvents, flag);
          }
        };

        function syncStoreFactory(params) {
          return new SyncStore(params);
        }

        return syncStoreFactory;
      }
    ]);

})(window, window.angular);
