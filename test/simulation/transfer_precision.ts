/*
  In this script, we generate random cycles of fragments growth and contraction
  and test the precision of fragments transfers
  During every iteration; percentageGrowth is sampled from a unifrom distribution between [-50%,250%]
  and the fragments total supply grows/contracts.
  In each cycle we test the following guarantees:
  - If address 'A' transfers x fragments to address 'B'. A's resulting external balance will
  be decreased by precisely x fragments, and B's external balance will be precisely
  increased by x fragments.
*/

import { ethers, upgrades } from 'hardhat'
import { expect } from 'chai'
import { BigNumber, BigNumberish, Contract, Signer } from 'ethers'
import { imul } from '../utils/utils'
const Stochasm = require('stochasm')

const INITIAL_EXCHANGE_RATE = ethers.BigNumber.from(10).pow(8)
const DECIMALS = 18
const FIRST_MINT_SUPPLY = ethers.utils.parseUnits('50', 6 + DECIMALS)

const endSupply = ethers.BigNumber.from(2).pow(128).sub(1)
const uFragmentsGrowth = new Stochasm({
  min: -0.5,
  max: 2.5,
  seed: 'fragments.org',
})

let uFragments: Contract,
  inflation: BigNumber,
  rebaseAmt = ethers.BigNumber.from(0),
  preRebaseSupply = ethers.BigNumber.from(0),
  postRebaseSupply = ethers.BigNumber.from(0),
  exchangeRate = INITIAL_EXCHANGE_RATE

async function checkBalancesAfterOperation(
  users: Signer[],
  op: Function,
  chk: Function,
) {
  const _bals = []
  const bals = []
  let u
  for (u in users) {
    if (Object.prototype.hasOwnProperty.call(users, u)) {
      _bals.push(await uFragments.balanceOf(users[u].getAddress()))
    }
  }
  await op()
  for (u in users) {
    if (Object.prototype.hasOwnProperty.call(users, u)) {
      bals.push(await uFragments.balanceOf(users[u].getAddress()))
    }
  }
  chk(_bals, bals)
}

async function checkBalancesAfterTransfer(users: Signer[], tAmt: BigNumberish) {
  await checkBalancesAfterOperation(
    users,
    async function () {
      await uFragments.connect(users[0]).transfer(users[1].getAddress(), tAmt)
    },
    function ([_u0Bal, _u1Bal]: BigNumber[], [u0Bal, u1Bal]: BigNumber[]) {
      const _sum = _u0Bal.add(_u1Bal)
      const sum = u0Bal.add(u1Bal)
      expect(_sum).to.eq(sum)
      expect(_u0Bal.sub(tAmt)).to.eq(u0Bal)
      expect(_u1Bal.add(tAmt)).to.eq(u1Bal)
    },
  )
}

async function exec() {
  const [deployer, user] = await ethers.getSigners()
  const factory = await ethers.getContractFactory('UFragments')
  const mockCollateralToken = await (
    await ethers.getContractFactory('MockERC20Token')
  )
    .connect(deployer)
    .deploy()
  const mockMarketOracle = await (await ethers.getContractFactory('MockOracle'))
    .connect(deployer)
    .deploy('MarketOracle')
  await mockMarketOracle.storeData(INITIAL_EXCHANGE_RATE)

  uFragments = await upgrades.deployProxy(
    factory,
    [await deployer.getAddress(), mockCollateralToken.address, 18],
    {
      initializer: 'initialize(address, address, uint256)',
    },
  )
  await uFragments.connect(deployer).setMarketOracle(mockMarketOracle.address)

  await mockCollateralToken.mint(await deployer.getAddress(), FIRST_MINT_SUPPLY)
  await mockCollateralToken
    .connect(deployer)
    .approve(uFragments.address, FIRST_MINT_SUPPLY)
  await uFragments.mint(await deployer.getAddress(), FIRST_MINT_SUPPLY)

  let i = 0
  do {
    preRebaseSupply = await uFragments.totalSupply()
    await mockMarketOracle.storeData(exchangeRate)
    await uFragments.connect(deployer).rebase()
    postRebaseSupply = await uFragments.totalSupply()
    i++

    console.log('Rebased iteration', i)
    console.log('Rebased by', rebaseAmt.toString(), 'AMPL')
    console.log('Total supply is now', postRebaseSupply.toString(), 'AMPL')

    console.log('Testing precision of 1c transfer')
    await checkBalancesAfterTransfer([deployer, user], 1)
    await checkBalancesAfterTransfer([user, deployer], 1)

    console.log('Testing precision of max denomination')
    const tAmt = await uFragments.balanceOf(deployer.getAddress())
    await checkBalancesAfterTransfer([deployer, user], tAmt)
    await checkBalancesAfterTransfer([user, deployer], tAmt)

    preRebaseSupply = await uFragments.totalSupply()
    inflation = uFragmentsGrowth.next().toFixed(5)
    rebaseAmt = imul(preRebaseSupply, inflation, 1)
    exchangeRate = imul(exchangeRate, inflation, 1)
  } while ((await uFragments.totalSupply()).add(rebaseAmt).lt(endSupply))
}

describe('Transfer Precision', function () {
  it('should successfully run simulation', async function () {
    await exec()
  })
})
