var agsdp = require("../../src/agsdataproviderbase");
var util = require("util");
var http = require("http");
var path = require("path");
var fs = require("fs");

Object.size = function(obj) {
    var size = 0, key;
    for (key in obj) {
        if (obj.hasOwnProperty(key)) size++;
    }
    return size;
};

CityBikes = function () {
	CityBikes.super_.call(this);

	this._isReady = false;
	this._cachedNetworks = null;
	this._cacheExpirationTime = new Date();
	var _cityBikesNetworksURL = "http://api.citybik.es/networks.json";
	
	this._networksCacheTime = 30 * 60000;
	this._stationCacheTime = 1 * 60000;

	this._networkTimezones = {};
	this._networksAwaitingTimezone = {};

	this._timezoneCacheFilename = path.join(path.dirname(module.filename),"data","timezones.json");

	if (fs.existsSync(this._timezoneCacheFilename))
	{
		this._networkTimezones = JSON.parse(fs.readFileSync(this._timezoneCacheFilename, 'utf8'));
		console.log("Loaded timezones from " + this._timezoneCacheFilename);
	}

	function _cacheInvalid(provider) {
		var now = new Date();
		var cacheInvalid = (provider._cachedNetworks == null) || (now >= provider._cacheExpirationTime);
		return cacheInvalid;
	}

	this._getTimezone = function(networkCacheEntry, callback) {
		var network = networkCacheEntry.network;
		var networkName = networkCacheEntry.network.name;
		if (this._networkTimezones.hasOwnProperty(networkName))
		{
			networkCacheEntry["timezone"] = this._networkTimezones[networkName];
			callback.call(this, networkCacheEntry);
		}
		else
		{
			this._networksAwaitingTimezone[networkName] = true;
			var timezoneUrl = util.format("http://api.timezonedb.com/?key=%s&lat=%d&lng=%d&format=json", "IMPMC00M2XNY", network.lat, network.lng);
			var provider = this;
			http.get(timezoneUrl, function (res) {
				var timezoneJSON = "";
				res.setEncoding('utf8');
				res.on('data', function(chunk) {
					timezoneJSON += chunk;
				});
				res.on('end', function() {
					var loadedTimezoneOK = false;
					var timezone = null;
					try
					{
						timezone = JSON.parse(timezoneJSON);
						loadedTimezoneOK = true;
					}
					catch (err)
					{
						console.log(err)
						console.log(timezoneJSON);
					}
				
					if (loadedTimezoneOK)
					{
						if (timezone.status === "OK")
						{
							delete timezone["status"];
							delete timezone["message"];
							timezone["cacheRefreshDue"] = (new Date()).getTime() + 24*60*60000;
							networkCacheEntry["timezone"] = timezone;

							provider._networkTimezones[networkName] = timezone;
				
							delete provider._networksAwaitingTimezone[networkName];
							console.log("Timezone: " + networkName + " (" + Object.size(provider._networksAwaitingTimezone) + ")");
							console.log(timezone);
							if (Object.size(provider._networksAwaitingTimezone) == 0)
							{
								if (!fs.existsSync(path.dirname(provider._timezoneCacheFilename))) {
									fs.mkDirSync(path.dirname(provider._timezoneCacheFilename));
								}
								fs.writeFile(provider._timezoneCacheFilename, JSON.stringify(provider._networkTimezones));
								console.log("Wrote timezones to " + provider._timezoneCacheFilename);
							}
							
							callback.call(provider, networkCacheEntry);
						}
					}
				});
			});
		}
	};

	this._networks = function(callback) {
		if (_cacheInvalid(this))
		{
			// Load the latest list of city services
			console.log("Caching Networks...");
			var added = 0;
			var provider = this;
			http.get(_cityBikesNetworksURL, 
					 function(res)
			{
				res.setEncoding('utf8');
				var networksJSON = "";

				res.on('data', function(chunk) {
					networksJSON = networksJSON + chunk;
				});

				res.on('end', function() {
					console.log("Caching Networks...");

					var networks = JSON.parse(networksJSON);
					var nc = {};

					// update cache
					for (var i=0; i<networks.length; i++)
					{
						var network = networks[i];
						if (!(network.name in nc))
						{
							network.lat = network.lat / 1000000;
							network.lng = network.lng / 1000000;
							var x = network.lng;
							var y = network.lat;
							var w = 0.5, h = 0.5;
							network["agsextent"] = {
								xmin: x - (w/2),
								xmax: x + (w/2),
								ymin: y - (h/2),
								ymax: y + (h/2),
								spatialReference: {
									"wkid": 4326,
									"latestWkid": 4326
								}
							};

							var networkCacheEntry = {
								"network": network, 
								"stations": { 
										lastReadTime: -1,
										cacheExpirationTime: new Date(),
										cachedStations: []
									},
								"timezone": null
							};
						
							nc[network.name] = networkCacheEntry;
						
							provider._getTimezone(networkCacheEntry, function() {
								if (process.env.VCAP_APP_PORT) {
									// Don't pre-cache unless deployed
									console.log("Precaching stations for " + networkCacheEntry.network.name);
									provider._stationsForNetwork(networkCacheEntry, function(stations) {
										return null;
									});
								}
							});
						
							added++
						}
					}
				
					provider._cacheExpirationTime = new Date();
					provider._cacheExpirationTime.setTime(provider._cacheExpirationTime.getTime() + provider._networksCacheTime);
					console.log("Cached " + added + " new networks!");
					console.log("Networks cache expires at: " + provider._cacheExpirationTime);
			
					callback(nc);
				});
			});
		}
		else
		{
			callback(this._cachedNetworks);
		}
	};

	this._classificationScheme = {
		"0": { "min": 0, "max": 0, "label": "No bikes" },
		"1": { "min": 1, "max": 1, "label": "1 bike" },
		"few": { "min": 2, "max": 8, "label": "A few bikes" },
		"plenty": { "min": 9, "max": 10000, "label": "Plenty of bikes" }
	};

	this._getBikeRange = function(station) {
		var bikesAvailable = station.attributes.bikes;
		var classes = [];
		for (var k in this._classificationScheme)
		{
			classes.push(k);
		}
	
		for (var i=0; i<classes.length; i++)
		{
			var className = classes[i];
			var classRange = this._classificationScheme[className];
			var min = classRange.min;
			var max = classRange.max;

			if (bikesAvailable >= min && bikesAvailable <= max)
			{
				station.attributes["bikesClass"] = classRange.label;
				break;
			}
		}
		if (!station.attributes.hasOwnProperty("bikesClass"))
		{
			station.attributes["bikesClass"] = "Woah, that's a lotta bikes!";
		}
	};

	this._stationsForNetwork = function(n, callback) {
		if (n.stations.lastReadTime != -1 &&
			n.stations.cacheExpirationTime > new Date())
		{
			console.log("Returning cached station results for " + n.network.name);
			callback(n.stations.cachedStations);
		}
		else
		{
			var cityBikesUrl = n.network.url;
			var provider = this;
			http.get(cityBikesUrl, function (res) {
				res.setEncoding('utf8');
				var stationsJSON = "";
			
				res.on('data', function(chunk) {
					stationsJSON = stationsJSON + chunk;
				});

				res.on('end', function() {
					var stationsData = JSON.parse(stationsJSON);

					n.stations.cachedStations = [];
					var minX = 0;
					var minY = 0;
					var maxX = 0;
					var maxY = 0;
					for (var i=0; i < stationsData.length; i++)
					{
						var station = stationsData[i];
					
						var tmp = new Date(station.timestamp);
						station["citybikesTimeString"] = station.timestamp;

						// The timestamps are CEST - fix by - 2 hours.
						tmp.setTime(tmp.getTime() - (2 * 60 * 60 * 1000));
						var epochMS = new Date(tmp).getTime();
						var localEpochMS = new Date(epochMS).getTime();

						station["utcTime"] = epochMS;
						
						gmtOffStr = "";

						if (n.timezone)
						{
							var gmtOffset = parseInt(n.timezone.gmtOffset);
							localEpochMS = localEpochMS + (gmtOffset * 1000);
							var offsetSeconds = n.timezone.gmtOffset,
								offsetMinutes = Math.round(Math.abs(offsetSeconds)/60),
								offsetMinRem = offsetMinutes%60,
								offsetHours = (offsetMinutes-offsetMinRem)/60;
							gmtOffStr += offsetSeconds<0?"-":"+";
							gmtOffStr += offsetHours==0?"00":((offsetHours<10?"0":"") + offsetHours);
							gmtOffStr += offsetMinRem==0?"00":((offsetMinRem<10?"0":"") + offsetMinRem);
							station["timezone"] = n.timezone.abbreviation;
							station["timezoneOffset"] = parseInt(n.timezone.gmtOffset);
						}
						else
						{
							gmtOffStr += "+0000";
							station["timezone"] = "GMT";
							station["timezoneOffset"] = 0;
							console.log("Uh oh - no timezone for " + n.network.name);
						}
						station["timezoneOffsetString"] = "GMT" + gmtOffStr;
						station["localTimeString"] = new Date(localEpochMS).toUTCString() + gmtOffStr;
					
						var x = station.lng / 1000000;
						var y = station.lat / 1000000;
						if (i==0) {
							minX = x;
							maxX = x;
							minY = y;
							maxY = y;
						} else {
							if (x < minX) minX = x;
							if (x > maxX) maxX = x;
							if (y < minY) minY = y;
							if (y > maxY) maxY = y;
						}
						var stationFeature = { 
							geometry: {
								x: x,
								y: y,
								spatialReference: {
									wkid: 4326
								}
							},
							attributes: JSON.parse(JSON.stringify(station))
						};
						provider._getBikeRange(stationFeature);
						delete stationFeature.attributes["lat"];
						delete stationFeature.attributes["lng"];
						delete stationFeature.attributes["coordinates"];
						delete stationFeature.attributes["timestamp"];
						n.stations.cachedStations.push(stationFeature);
					}
					n.stations["extent"] = n.network["agsextent"] = {
						xmin: minX, ymin: minY,
						xmax: maxX, ymax: maxY,
						spatialReference: {
							"wkid": 4326,
							"latestWkid": 4326
						}
					};
					n.stations.lastReadTime = new Date();

					n.stations.cacheExpirationTime =
						new Date(n.stations.lastReadTime.getTime() + provider._stationCacheTime);

					console.log(util.format('Cached %d stations for %s at %s (expires %s)',
											stationsData.length, n.network.name,
											n.stations.lastReadTime,
											n.stations.cacheExpirationTime));
				
					callback(n.stations.cachedStations);
				});
			});
		}
	};

	var citybikesProvider = this;
	this._networks(function(networkList) {
		citybikesProvider._cachedNetworks = networkList;
		citybikesProvider._isReady = true;
	});
};

util.inherits(CityBikes, agsdp.AgsDataProviderBase);

// Property overrides
Object.defineProperties(CityBikes.prototype, {
	name: {
		get: function() {
			return "citybikes";
		}
	},
	isReady: {
		get: function() {
			return this._isReady;
		}
	},
	serviceIds: {
		get: function() {
			var out = [];
			if (this._isReady) {
				for (var networkName in this._cachedNetworks) {
					out.push(networkName);
				}
			}
			return out.sort();
		}
	},
	fields: {
		value: function(serviceId, layerId) {
			return [
				{"name" : "id", "type" : "esriFieldTypeInteger", "alias" : "ID", "nullable" : "true"},
				{"name" : "idx", "type" : "esriFieldTypeInteger", "alias" : "IDX", "nullable" : "true"},
				{"name" : "name", "type" : "esriFieldTypeString", "alias" : "Name", "length" : "255", "nullable" : "true"},
				{"name" : "number", "type" : "esriFieldTypeInteger", "alias" : "Number", "nullable" : "true"},
				{"name" : "free", "type" : "esriFieldTypeInteger", "alias" : "Free", "nullable" : "true"},
				{"name" : "bikes", "type" : "esriFieldTypeInteger", "alias" : "Bikes", "nullable" : "true"},
				{"name" : "bikesClass", "type" : "esriFieldTypeString", "alias" : "Bikes Class", "length" : "255", "nullable" : "true"},
				{"name" : "address", "type" : "esriFieldTypeString", "alias" : "Address", "length" : "255", "nullable" : "true"},
				{"name" : "citybikesTimeString", "type" : "esriFieldTypeString", "alias" : "CityBikes Time", "length" : "255", "nullable" : "true"},
				{"name" : "utcTime", "type" : "esriFieldTypeDate", "alias" : "UTC Timestamp", "length" : 36, "nullable" : "true"},
				{"name" : "timezone", "type" : "esriFieldTypeString", "alias" : "Timezone Code", "length" : "5", "nullable" : "true"},
				{"name" : "timezoneOffset", "type" : "esriFieldTypeInteger", "alias" : "Timezone Offset", "nullable" : "true"},
				{"name" : "timezoneOffsetString", "type" : "esriFieldTypeString", "alias" : "Timezone Offset String", "length" : "8", "nullable" : "true"},
				{"name" : "localTimeString", "type" : "esriFieldTypeString", "alias" : "Local Time", "length" : "255", "nullable" : "true"},
			];
		}
	},
	featuresForQuery: {
		value: function(serviceId, layerId, query, callback) {
			var provider = this;
			this._networks(function(networks) {
				var network = networks[serviceId];
				provider._stationsForNetwork(network, function(stationFeatures) {
					callback(stationFeatures);
				});
			});
		}
	},
	featureServiceDetails: {
		value: function(detailsTemplate, serviceId, layerId) {
			if (this._cachedNetworks &&
				this._cachedNetworks.hasOwnProperty(serviceId)) {
				var network = this._cachedNetworks[serviceId].network;
				if (network.hasOwnProperty("agsextent"))
				{
					detailsTemplate.initialExtent = network.agsextent;
				}
			}
			return detailsTemplate;
		}
	},
	featureServiceLayerDetails: {
		value: function(detailsTemplate, serviceId, layerId) {
			if (this._cachedNetworks &&
				this._cachedNetworks.hasOwnProperty(serviceId)) {
				var network = this._cachedNetworks[serviceId].network;
				if (network.hasOwnProperty("agsextent"))
				{
					detailsTemplate.extent = network.agsextent;
				}
				else
				{
					var x = network.lng;
					var y = network.lat;
					var w = 0.25, h = 0.25;
					detailsTemplate.extent.xmin = x - w;
					detailsTemplate.extent.xmax = x + w;
					detailsTemplate.extent.ymin = y - h;
					detailsTemplate.extent.ymax = y + h;
				}
			}
			return detailsTemplate;
		}
	}
});

exports.CityBikes = CityBikes;