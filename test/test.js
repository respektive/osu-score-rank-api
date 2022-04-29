const Redis = require("ioredis");
const redisClient = new Redis();

async function main() {
    let user_id = 1023489;
    let score = await redisClient.zscore("score_osu", user_id);
    let rank = await redisClient.zrevrank("score_osu", user_id);
    let username = await redisClient.get(`user_${user_id}`);
    
    let rankings = await redisClient.zrevrange("score_osu", 0, 49, "WITHSCORES");
    let rank_user = await redisClient.zrevrange("score_osu", 726, 726, "WITHSCORES");
    
    console.log("Rank and Score for User " + username);
    console.log("#" + (rank + 1) + " " + score);
    

    let lb = {};
    let r = 0;

    for(let i = 0; i < rankings.length; i+=2) {
        lb[r] = {};
        lb[r]["rank"] = r + 1;
        lb[r]["user_id"] = rankings[i];
        lb[r]["username"] = await redisClient.get(`user_${rankings[i]}`);
        lb[r]["score"] = rankings[i+1];
        r++
    }

    console.log(rankings);
    console.log(lb);

    let ru = {};
    let a = 726;

    for(let i = 0; i < rank_user.length; i+=2) {
        ru["rank"] = a + 1;
        ru["user_id"] = rank_user[i];
        ru["username"] = await redisClient.get(`user_${rank_user[i]}`);
        ru["score"] = rank_user[i+1];
    }

    console.log("user for rank 727");
    console.log(ru);

}

main();